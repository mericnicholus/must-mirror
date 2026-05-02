## MUST Mirror

MUST Mirror is an offline classroom presentation and collaboration system built for lecture environments where internet access may be unreliable or completely unavailable. A host can start a class on one laptop, students can join from phones or laptops on the same local network, and the class can share screen content, audio, chat, attendance, and issue reports without depending on a cloud service.

This README is the main project guide for the codebase. It is written to help you:
- understand what the system does
- set it up locally
- trace key features back to the exact implementation files

## 1. What This Project Does

MUST Mirror supports:
- host-led screen sharing for teaching
- student joining through a room code or local link
- two-way audio paths between host and students
- controlled student screen sharing back to the class
- live classroom chat
- attendance capture and CSV export
- performance logging for network and session quality
- feedback reporting with screenshot upload
- admin monitoring through a dashboard
- offline-first usage over LAN, hotspot, or tethered local network

Main entry points:
- Student/host landing page: `public/index.html`
- Server: `server.js`
- Database layer: `database.js`
- Admin dashboard: `admin-dashboard.html`

## 2. Technology Stack

### Frontend
- HTML, CSS, vanilla JavaScript
- WebRTC for media transport
- Socket.IO client for signaling and real-time events

### Backend
- Node.js runtime
- Express for HTTP endpoints and static file serving
- Socket.IO for WebRTC signaling, room events, chat, and live updates

### Database
- SQLite (`sqlite3`) for local persistent storage
- WAL mode, foreign keys, and migration helpers in `database.js`

### Media / Collaboration
- WebRTC peer connections for screen and audio exchange
- A lightweight in-memory SFU helper in `public/sfu-server.js` for stream coordination

### Production Build / Protection
- `terser` for JavaScript minification
- `javascript-obfuscator` for production obfuscation
- CSS/HTML minification in `scripts/build-production.js`

See:
- `package.json`
- `scripts/build-production.js`
- `server.js:1`
- `database.js:1`

## 3. High-Level Architecture

At a high level, the system works like this:

1. The Node.js server starts on the host machine.
2. Students open the host URL over the same local network.
3. The host creates a session.
4. Socket.IO handles signaling, room presence, chat, and class state.
5. WebRTC carries the actual screen/audio media.
6. SQLite stores users, sessions, attendance, feedback, and performance logs.
7. The admin dashboard reads from secure backend APIs.

### Main files and responsibilities
- `server.js`: HTTP routes, Socket.IO events, room state, admin auth, session lifecycle
- `database.js`: schema creation, migrations, data access methods, exports, analytics
- `public/app.js`: shared UI logic, landing page actions, feedback flow, connectivity help
- `public/presenter.js`: host behavior, starting class, screen sharing, attendance export, host chat
- `public/student.js`: student join flow, receiving content, student screen sharing, tab policy
- `public/styles.css`: UI styling and responsive layouts
- `public/sfu-server.js`: simple selective forwarding logic
- `admin-dashboard.html`: monitoring UI for sessions, users, performance, and feedback

## 4. How The System Works

### 4.1 Landing page
The landing page presents two roles: `Host` and `Student`.

Relevant code:
- `public/index.html:39`
- `public/app.js:173`
- `public/styles.css:2017`

### 4.2 Host flow
The host:
1. opens the app
2. chooses `Host`
3. fills in presenter details
4. starts the class
5. receives a generated room code
6. shares the room or host URL with students
7. starts screen sharing and optionally microphone/audio

Relevant code:
- Host setup form: `public/index.html:195`
- Presenter email field: `public/index.html:201`
- Presenter socket logic: `public/presenter.js`
- Room creation event: `server.js:876`

### 4.3 Student flow
The student:
1. opens the same local host URL
2. chooses `Student`
3. joins using a discovered room or typed room code
4. receives host media and chat updates
5. can send chat, voice, and controlled screen sharing when allowed

Relevant code:
- Student setup form: `public/index.html:210`
- Quick join from landing: `public/app.js:173`
- Join room logic: `public/student.js:176`
- Server join event: `server.js:966`

### 4.4 Chat flow
Chat messages are kept per room in memory and broadcast through Socket.IO.

Relevant code:
- Shared chat UI helpers: `public/app.js:430`
- Presenter chat sending: `public/presenter.js:209`
- Student chat sending: `public/student.js:741`
- Server chat event: `server.js:1276`

### 4.5 One sharer at a time
The system enforces one active screen sharer in a room at a time. If someone else is already sharing, the next user gets a `screen-share-denied` response.

Relevant code:
- Active sharer room state: `server.js:929`
- Host screen-share guard: `server.js:1141`
- Student share guard: `server.js:1258`
- Client denial handling: `public/presenter.js:55`, `public/student.js:122`

### 4.6 Two-way audio
Both host and student clients maintain remote audio streams so audio can move in both directions where the browser grants permission and tracks are added to the peer connection.

Relevant code:
- Host remote audio stream: `public/presenter.js:9`
- Host audio attachment: `public/presenter.js:620`
- Student remote audio stream: `public/student.js:14`
- Student audio attachment: `public/student.js:567`
- Shared mute action: `public/app.js:204`

## 5. How The Class Code Is Generated

The class code is generated on the server using a cryptographically secure random generator.

Source:
- `server.js`

### Current generation rule
The server now:
- uses a restricted alphabet of uppercase letters and digits that avoids confusing characters such as `O`, `0`, `I`, and `1`
- generates each character with Node.js `crypto.randomInt(...)`
- groups the code in an `XXXX-XXXX` format for easier classroom sharing
- checks the generated code against active rooms and saved sessions to avoid collisions

Example:
- Generated room code: `K7QX-4M2P`

Important notes:
- The room ID is still normalized by `sanitizeRoomId()` so only uppercase letters, numbers, and dashes remain.
- If a preview code is missing or already exists, the server generates a fresh unique one during room creation.
- This is more secure than the previous predictable department-name format because the code cannot be guessed from presenter details.

Related code:
- `server.js` - secure room code generation
- `server.js` - room ID sanitization
- `server.js` - `/api/room-id`
- `server.js` - final room ID resolution during room creation

## 6. Offline-First Design

This system is designed to work best on a local classroom network.

### What “offline-first” means here
It does not need the public internet to run if the host and student devices can reach each other over the same local network.

Examples:
- campus Wi-Fi with no internet
- laptop hotspot
- phone hotspot
- USB/Bluetooth tethering that creates a local IP path

### Important Bluetooth clarification
Bluetooth helps mainly with network bridging or tethering, not as the primary transport for full classroom WebRTC media. The screen/audio traffic still depends on IP connectivity.

Relevant code:
- Client configuration endpoint: `server.js:186`
- Network info endpoint: `server.js:199`
- Connectivity help modal: `public/index.html:357`
- Copy host URL button: `public/app.js:834`

## 7. Scaling Behavior And Classroom Size

The app includes class-scale awareness and performance logging, but it is still constrained by the host machine, browser limits, and local network quality.

### Current scaling support in code
- scale thresholds are defined on the server
- the room emits `class-scale-update` guidance
- performance logs are throttled to reduce database spam
- a lightweight SFU helper exists, but this is not yet a full enterprise media cluster

Relevant code:
- Scale thresholds: `server.js:771`
- Class-scale broadcast: `server.js:847`
- Performance log throttling: `server.js:782`
- Performance logging API: `server.js:644`
- SFU helper: `public/sfu-server.js`

## 8. Database Design

The database is created and migrated in `database.js`.

Main schema creation entry:
- `database.js:28`

### Core tables
- `users` - people who use the system (`database.js:38`)
- `sessions` - host classroom sessions (`database.js:51`)
- `attendance` - student join/leave records (`database.js:87`)
- `performance_logs` - connection and quality measurements (`database.js:101`)
- `user_feedback` - reports, ratings, issues, screenshots (`database.js:120`)
- `admin_users` - admin authentication records (`database.js:135`)

### Why SQLite was used
SQLite fits this project well because:
- it is lightweight
- it works offline
- it is easy to deploy on one machine
- it keeps the system simple for classroom use and demos

### Database safety already in code
- `PRAGMA foreign_keys = ON`
- `PRAGMA journal_mode = WAL`
- `PRAGMA busy_timeout = 5000`
- `PRAGMA trusted_schema = OFF`

Relevant code:
- `database.js:31`
- `database.js:32`
- `database.js:33`
- `database.js:34`

## 9. Feedback System

The feedback system is designed around reporting problems in the screen-sharing experience rather than acting like a generic app review form.

### What a feedback report includes
- who submitted it
- role (`presenter` or `student`)
- rating chosen by the user
- issue type
- description
- optional screenshot
- current status

### Screenshot storage design
Screenshots are saved to disk in `uploads/feedback/`, while the database stores the file path and metadata.

Why this is the chosen design:
- it keeps SQLite smaller
- it avoids large image blobs inside the DB
- it is better for offline maintenance and admin review

Relevant code:
- Screenshot folder path: `server.js:40`
- Screenshot save helper: `server.js:57`
- Feedback API: `server.js:687`
- Feedback DB insert: `database.js:485`
- Feedback screenshot path column migration: `database.js:276`
- Admin dashboard screenshot link: `admin-dashboard.html:119`
- Feedback modal UI: `public/index.html:288`
- Feedback submission flow: `public/app.js:662`

## 10. Attendance And Export

Attendance is recorded when a student joins a live room and can be exported by the host as CSV.

Relevant code:
- Mark attendance: `database.js:816`
- Export attendance CSV: `database.js:877`
- Attendance export API: `server.js:469`
- Presenter export action: `public/presenter.js:784`
- Export button: `public/index.html:125`

## 11. Admin Dashboard

The admin dashboard lets an administrator review:
- active rooms
- sessions
- users
- performance logs
- feedback reports

### Admin authentication
Admin login is token-based and protected through backend middleware.

Relevant code:
- Default admin env variables: `server.js:236`, `server.js:237`
- Admin bootstrap account: `server.js:270`
- Admin login route: `server.js:316`
- Admin auth middleware path: `server.js:281`
- Dashboard login UI: `admin-dashboard.html:43`
- Stored bearer token handling: `admin-dashboard.html:64`

### Default admin credentials
By default, the app creates:
- Username: `admin`
- Password: `MustMirror@Admin123`

You should change these in a real deployment by setting environment variables.

## 12. Security Measures Already Present

Current protections in the code include:
- blocked scraper/clone user agents
- CORS restrictions for allowed origins
- Content Security Policy and defensive headers
- admin token validation
- disabled right-click/copy/cut/paste/select in the client UI
- DB hardening pragmas and migration safeguards
- production minification/obfuscation build

Relevant code:
- Blocked agents and headers: `server.js:107` to `server.js:146`
- Admin token issuance: `server.js:262`
- Client content protection: `public/app.js:747`
- Production build: `scripts/build-production.js`

## 13. Project Structure

```text
must-mirror/
|-- public/
|   |-- index.html
|   |-- styles.css
|   |-- app.js
|   |-- presenter.js
|   |-- student.js
|   |-- sfu-server.js
|   `-- webrtc-utils.js
|-- scripts/
|   `-- build-production.js
|-- uploads/
|   `-- feedback/
|-- admin-dashboard.html
|-- feedback.html
|-- server.js
|-- database.js
|-- package.json
`-- wireless_screen_sharing.db
```

## 14. Local Setup

### Prerequisites
- Node.js 18+ recommended
- npm
- A modern browser with WebRTC support

### Install
```bash
npm install
```

### Run in development
```bash
npm start
```

The app starts on:
- `http://localhost:3001`

Port source:
- `server.js:1426`

### Run with auto-reload
```bash
npm run dev
```

### Production build
```bash
npm run build:prod
npm run start:prod
```

Production build source:
- `scripts/build-production.js`
- `package.json`

## 15. Environment Variables

Supported runtime variables from the codebase include:
- `PORT` - server port
- `NODE_ENV` - `production` or `development`
- `SOCKET_SERVER_URL` - explicit socket server URL returned to clients
- `DB_PATH` - alternate database file path
- `DB_PASSPHRASE` - SQLCipher passphrase used to open or migrate the database
- `DB_CIPHER_COMPATIBILITY` - SQLCipher compatibility mode, default `4`
- `ADMIN_USERNAME` - admin username override
- `ADMIN_PASSWORD` - admin password override
- `ADMIN_SESSION_TTL_MS` - admin token lifetime
- `MESH_WARNING_MEDIUM` - medium-size class threshold
- `MESH_WARNING_LARGE` - large-size class threshold
- `MESH_WARNING_XLARGE` - extra-large class threshold
- `PERFORMANCE_LOG_INTERVAL_MS` - performance log throttle interval

### SQLCipher setup

To enable encrypted database mode, start the server with a passphrase:

```powershell
$env:DB_PASSPHRASE="Choose-A-Strong-Secret"
npm start
```

Notes:
- On first startup with `DB_PASSPHRASE` set, the app attempts to migrate the current plaintext classroom database into a SQLCipher-encrypted file and keeps a timestamped plaintext backup.
- By default, the encrypted database remains `wireless_screen_sharing.db` in the project folder unless `DB_PATH` is explicitly set.
- If the database is already encrypted, the same passphrase is required on every startup.
- `DB_CIPHER_COMPATIBILITY` defaults to `4`, which matches SQLCipher 4 defaults.

Relevant code:
- `server.js:188`
- `server.js:236`
- `server.js:237`
- `server.js:238`
- `database.js`
- `server.js:768`
- `server.js:769`
- `server.js:770`
- `server.js:771`

## 16. How To Use In A Real Classroom

### Host machine
1. Start the server on the host laptop.
2. Ensure students can reach the host over local network, hotspot, or tethering.
3. Open the app and choose `Host`.
4. Enter host details.
5. Start the class and share the room code or copied host URL.

### Student devices
1. Connect to the same network.
2. Open the host URL.
3. Choose `Student`.
4. Enter student details and join the room.

### If students struggle to find the host
Use the in-app connectivity helper.

Relevant code:
- Network discovery endpoint: `server.js:199`
- Connectivity helper fetch: `public/app.js:813`
- Copy button: `public/app.js:853`

## 17. Troubleshooting

### Room creation fails
Check:
- presenter details are filled in
- the database file is not locked by another tool
- the presenter email and user creation path are valid

Relevant code:
- Session creation: `database.js:418`
- Room creation socket event: `server.js:876`

### Feedback does not submit
Check:
- the device is online according to browser state
- a rating has been chosen
- issue type and description are filled in
- screenshot, if any, is a valid image

Relevant code:
- Connectivity check: `public/app.js:614`
- Feedback submit validation: `public/app.js:662`
- Feedback API: `server.js:687`

### Too many performance logs
The server now throttles repeated performance logs so the database is not flooded.

Relevant code:
- `server.js:782`
- `server.js:796`

### Students cannot all share at once
That is intentional. The app allows one active screen sharer at a time to keep the session stable and understandable.

Relevant code:
- `server.js:1141`
- `server.js:1258`

