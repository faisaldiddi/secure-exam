# SecureExam AI — Major Review 1 (50% Working Prototype)

## What works
- Role-based login: ADMIN / PAPER_SETTER / REVIEWER
- Password hashing with bcrypt
- 6-digit OTP with 5-minute expiry
- Optional real email OTP via SMTP; terminal OTP fallback for demo
- Secure dashboard with paper counts and user risk score
- Secure in-browser exam paper creation and editing
- AES-256-GCM encryption before paper content is stored
- Draft → Pending Review → Approved workflow
- Approved papers are locked from editing
- Dynamic session watermark in secure viewer
- Webcam/camera-tamper monitoring and automatic secure-view lock
- Audit trail for logins, paper access, edits, submission and approval
- Security event log and transparent risk scoring
- Admin staff creation
- Admin endpoint to demonstrate ciphertext stored in the database

## Phase 2 / Final Review
- Full biometric face recognition + liveness
- CCTV mobile-phone / suspicious-object detection
- Invisible forensic watermark decoding from leaked photos
- Registered-device binding
- Dual-control print authorization
- Advanced anomaly/ML risk engine

## Run on Windows
1. Install Node.js 18+.
2. Extract this folder.
3. Open PowerShell or CMD inside the folder.
4. Run:

```bash
npm install
npm start
```

5. Open: `http://localhost:3000`

## Demo accounts
All passwords: `Pass@123`

- Admin: `admin@demo.edu`
- Paper Setter: `setter@demo.edu`
- Reviewer: `reviewer@demo.edu`

### OTP during review
By default the generated OTP is printed in the terminal where `npm start` is running.

For real email OTP, copy `.env.example` to `.env` and configure SMTP values.

## Best 3–5 minute review demo
1. Login as `setter@demo.edu`.
2. Read OTP from terminal and verify.
3. Create a Machine Learning paper.
4. Open the paper list and click **Show Encryption** only from Admin later to prove ciphertext storage.
5. Submit the paper for review.
6. Logout; login as `reviewer@demo.edu` and approve it.
7. Open the Secure Viewer and allow webcam access.
8. Cover the webcam or switch away from the page to trigger a security lock/event.
9. Login as Admin and open Security Events / Audit Trail.
10. Show the increased risk score and stored audit events.

## Notes for judges / teachers
The Review-1 viewer intentionally demonstrates camera health/tamper monitoring rather than claiming full face recognition. Full biometric matching and liveness are a Phase-2 feature. This keeps the current prototype technically accurate.

## Data storage
For zero-setup review use, this prototype stores records in `data/db.json` while paper content itself is encrypted before storage. The final version can replace this storage layer with MongoDB/PostgreSQL without changing the security workflow.
