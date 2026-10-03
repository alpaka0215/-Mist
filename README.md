# MIST

로그인 없는 익명 커뮤니티. 게시판은 **로**라고 부릅니다.

| 로 | 내용 |
|---|---|
| 자유로 | 자유게시판 |
| 공지로 | 누구나 읽기, 글쓰기는 운영자 비밀번호 필요 |
| 인기로 | 최근 7일 글 중 반응(조회·좋아요·댓글)이 높은 글 자동 노출 |
| 유저로 | 누구나 새 로를 만들고, 만들어진 로 전체를 확인 |

## 파일 구조

```
mist/
├─ server.js          서버 전체 (API · DB · 사진 처리)
├─ public/
│  ├─ index.html      화면 틀
│  ├─ style.css       디자인 (라이트/다크 자동)
│  ├─ app.js          화면 동작
│  └─ favicon.svg
├─ package.json       사용 라이브러리 3개: express, multer, better-sqlite3
├─ Dockerfile         배포용
└─ .env.example       환경변수 예시
```

실행하면 `data/` 폴더가 생기고 그 안에 `mist.db`(글·댓글·좋아요·로)와 `uploads/`(사진)가 저장됩니다. **이 폴더만 지키면 모든 데이터가 유지됩니다.**

## 환경변수

| 이름 | 필수 | 설명 |
|---|---|---|
| `ADMIN_PASSWORD` | 필수 | 공지로 글쓰기, 모든 글·댓글·로 삭제에 쓰는 운영자 비밀번호. 비워두면 공지로 글쓰기가 꺼짐 |
| `PORT` | 선택 | 기본 3000. 호스팅 서비스는 자동 지정 |
| `DATA_DIR` | 선택 | 데이터 저장 폴더. 기본 `./data`, Docker 기본 `/data` |
| `TRUST_PROXY` | 선택 | Railway 같은 호스팅 뒤에서 돌릴 때 `1` |

## 내 컴퓨터에서 실행

Node.js 22 이상을 설치한 뒤 이 폴더에서:

```bash
npm install
cp .env.example .env        # 윈도우는: copy .env.example .env
# .env 파일을 열어 ADMIN_PASSWORD를 바꾸기
npm run dev
```

브라우저에서 `http://localhost:3000` 접속.

## 인터넷에 배포 (Railway, 가장 쉬운 방법)

MIST는 서버와 저장공간이 필요해서 **GitHub Pages나 Cloudflare Pages(정적 사이트 전용)에는 올릴 수 없습니다.** Railway는 GitHub 저장소만 연결하면 Dockerfile을 알아서 읽어 배포합니다. (소규모 기준 월 5달러 안팎)

1. 이 폴더를 GitHub 저장소로 올립니다. (`.gitignore`가 있어 `node_modules`, `data`, `.env`는 올라가지 않음)
2. railway.com 가입 → **New Project → Deploy from GitHub repo** → 저장소 선택
3. 생성된 서비스에서 **Variables** 탭에 추가
   - `ADMIN_PASSWORD` = 길고 추측하기 어려운 비밀번호
   - `TRUST_PROXY` = `1`
4. 서비스 우클릭(또는 Command Palette) → **Add Volume** → Mount path에 `/data` 입력
   - ⚠️ 이 단계를 빼면 재배포할 때마다 글과 사진이 사라집니다.
5. **Settings → Networking → Generate Domain** 을 누르면 주소가 생깁니다. 끝.

코드를 고쳐 GitHub에 다시 올리면 자동으로 재배포되고, 데이터는 볼륨에 그대로 남습니다.

## 다른 배포 방법: 내 서버(VPS)에서 Docker로

```bash
docker build -t mist .
docker run -d --name mist --restart unless-stopped \
  -p 3000:3000 \
  -e ADMIN_PASSWORD='길고-어려운-비밀번호' \
  -v mist-data:/data \
  mist
```

HTTPS는 앞단에 Caddy 같은 웹서버를 두면 자동 인증서가 붙습니다. (`your-domain.com { reverse_proxy localhost:3000 }`). 이 경우 `-e TRUST_PROXY=1`을 추가합니다.

## 운영자 기능

별도 계정 없이 `ADMIN_PASSWORD` 하나로 처리합니다.

- **공지 쓰기**: 공지로에서 "글 작성하기" → 운영자 비밀번호 입력
- **아무 글·댓글 삭제**: 삭제 버튼에서 작성자 비밀번호 대신 운영자 비밀번호 입력
- **유저로의 로 삭제** (그 안의 글·사진도 함께 삭제). 로 주소가 `.../#/r/abc123`이면:

```bash
curl -X DELETE https://내주소/api/boards/abc123 \
  -H 'Content-Type: application/json' \
  -d '{"adminPassword":"운영자비밀번호"}'
```

## 백업

`data/` 폴더 전체(Railway는 볼륨)를 복사하면 됩니다. 가장 안전하게는 서버를 잠깐 멈춘 뒤 복사합니다.

## 개인정보·보안 설계

| 항목 | 처리 방식 |
|---|---|
| IP·접속 기록 | 저장 안 함. 요청 로그를 남기는 코드 자체가 없음 |
| DB에 저장되는 것 | 로(이름), 글(제목·내용·작성자명·사진 파일명·조회/좋아요/댓글 수·작성시각), 댓글(작성자명·내용·작성시각), 삭제 비밀번호의 해시값 |
| 비밀번호 | scrypt + 개별 salt 해시로만 저장. 원문은 저장하지 않음 |
| 사진 | 위치(GPS)·촬영기기 등 메타데이터를 저장 전에 제거. 회전 정보만 남김. 파일명은 무작위로 변경 |
| 좋아요 중복 방지 | 누른 기록은 사용자 기기(브라우저)에만 저장. 서버는 누가 눌렀는지 모름 |
| 조회수 | 같은 창에서 반복 조회는 1회로 계산 (기기에서 판단) |
| 도배 방지 | 1분 단위 횟수 제한. 메모리에만 1분간, 원본 IP가 아닌 무작위 해시값으로 유지하고 디스크에 쓰지 않음. 서버 재시작 시 사라짐 |
| 화면 보안 | 글 내용은 모두 텍스트로 출력(스크립트 실행 불가), 외부 리소스 차단(CSP), 외부로 주소 전달 안 함(no-referrer) |

> 참고: MIST 자체는 기록을 남기지 않지만, **호스팅 업체(Railway 등)나 앞단 웹서버가 자체 접속 로그를 남길 수 있습니다.** 이는 앱 바깥의 영역이라, 엄격하게 운영하려면 해당 서비스의 로그 설정을 확인하거나 직접 관리하는 서버를 쓰세요.

## 기본값 바꾸기

`server.js` 위쪽 설정 부분에서 수정합니다.

| 항목 | 기본값 |
|---|---|
| 제목 / 내용 / 댓글 / 작성자명 / 로 이름 | 100 / 5000 / 1000 / 20 / 20자 |
| 사진 | 글당 4장, 장당 8MB (큰 사진은 기기에서 자동 축소 후 업로드) |
| 인기로 기준 | 최근 7일, 점수 = 조회 + 좋아요×10 + 댓글×5, 20점 이상 |
| 도배 방지 (1분당) | 글 5, 댓글 10, 로 생성 3, 좋아요 30, 삭제 시도 20 |
