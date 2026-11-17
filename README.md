# 서울이 선다 (seoul-ar)

폰 카메라로 발표 화면의 그림을 비추면 그림 위에 서울 25개 자치구와 법정동 실거래 막대가 3D로 서고,
발표자의 선택이 모든 폰에 실시간으로 반영되는 웹앱. AWS 캡스톤 자유 프로젝트.

- 설계: `docs/superpowers/specs/2026-11-17-seoul-ar-design.md`
- 모듈 계약: `docs/CONTRACTS.md`
- 계획: `docs/superpowers/plans/2026-11-17-seoul-ar.md`
- `tools/` 데이터 집계, 지오 변환, 마커 생성 (Node 24, vitest)
- `frontend/` Vite + TypeScript + three + mind-ar + aws-amplify(events)
- `infra/` CDK(JS) us-east-1: S3 비공개 + CloudFront OAC + AppSync Events
