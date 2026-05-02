
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const database = require('./database.js');

/**
 * OFFLINE SCREEN SHARING SERVER
 * -----------------------------
 * Technology Stack:
 * - Node.js: Runtime environment
 * - Express: Web server for static files
 * - Socket.io: Real-time signaling for WebRTC
 * - WebRTC: Peer-to-peer screen sharing (Scalable via SFU)
 */

// Import SFU (Selective Forwarding Unit) for scalable streaming
// This allows one presenter to stream to many students efficiently
const SFUServer = require('./public/sfu-server.js');
const sfu = new SFUServer();

const app = express();
const server = http.createServer(app);
app.disable('x-powered-by');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SOURCE_PUBLIC_DIR = path.join(__dirname, 'public');
const DIST_ROOT_DIR = path.join(__dirname, 'dist');
const DIST_PUBLIC_DIR = path.join(DIST_ROOT_DIR, 'public');
const STATIC_PUBLIC_DIR = IS_PRODUCTION && fs.existsSync(DIST_PUBLIC_DIR)
  ? DIST_PUBLIC_DIR
  : SOURCE_PUBLIC_DIR;
const STATIC_ROOT_DIR = IS_PRODUCTION && fs.existsSync(DIST_ROOT_DIR)
  ? DIST_ROOT_DIR
  : __dirname;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const FEEDBACK_UPLOADS_DIR = path.join(UPLOADS_DIR, 'feedback');

function ensureDirectoryExists(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

function getExtensionFromMimeType(mimeType = '') {
  const normalized = String(mimeType).toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  return '.png';
}

function saveFeedbackScreenshot(screenshot) {
  if (!screenshot?.data || !screenshot?.type) {
    return null;
  }

  const match = String(screenshot.data).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  const mimeType = match[1].toLowerCase();
  if (!mimeType.startsWith('image/')) {
    return null;
  }

  ensureDirectoryExists(FEEDBACK_UPLOADS_DIR);
  const extension = getExtensionFromMimeType(mimeType);
  const fileName = `feedback_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${extension}`;
  const filePath = path.join(FEEDBACK_UPLOADS_DIR, fileName);
  fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));

  return {
    fileName,
    relativePath: `/uploads/feedback/${fileName}`
  };
}

function isPrivateNetworkHost(hostname = '') {
  return /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)$/.test(hostname);
}

function isAllowedSocketOrigin(origin = '') {
  if (!origin) return true;

  try {
    const parsed = new URL(origin);
    if (parsed.hostname === 'must-mirror.vercel.app') return true;
    if (isPrivateNetworkHost(parsed.hostname)) return true;
  } catch (error) {
    return false;
  }

  return false;
}

const io = socketIo(server, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedSocketOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Not allowed by CORS'));
    },
    methods: ["GET", "POST"]
  }
});

// Initialize SFU with the socket.io instance
sfu.setIO(io);

const blockedCloneAgents = [
  'httrack',
  'wget',
  'curl',
  'python-requests',
  'scrapy',
  'go-http-client',
  'libwww-perl',
  'webcopier',
  'sitesucker'
];

app.use((req, res, next) => {
  const userAgent = (req.get('user-agent') || '').toLowerCase();
  const isBlockedAgent = blockedCloneAgents.some(agent => userAgent.includes(agent));

  if (isBlockedAgent) {
    return res.status(403).send('Access denied');
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' ws: wss: http://localhost:3001 https://must-mirror.vercel.app",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join('; ')
  );

  next();
});

app.use((req, res, next) => {
  if (/\.map$/i.test(req.path)) {
    return res.status(404).send('Not found');
  }

  next();
});

app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedSocketOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(STATIC_PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

// Serve admin dashboard from root directory
app.get('/admin-dashboard.html', (req, res) => {
  res.sendFile(path.join(STATIC_ROOT_DIR, 'admin-dashboard.html'));
});

// Serve feedback form from root directory
app.get('/feedback.html', (req, res) => {
  res.sendFile(path.join(STATIC_ROOT_DIR, 'feedback.html'));
});

app.get('/api/client-config', (req, res) => {
  const configuredSocketUrl = process.env.SOCKET_SERVER_URL;
  const protocol = req.protocol || 'http';
  const host = req.get('host');
  const resolvedSocketUrl = configuredSocketUrl || `${protocol}://${host}`;

  res.json({
    socketServerUrl: resolvedSocketUrl,
    mode: IS_PRODUCTION ? 'production' : 'development'
  });
});

app.get('/api/network-info', (req, res) => {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  Object.keys(interfaces).forEach((name) => {
    (interfaces[name] || []).forEach((entry) => {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push({
          interface: name,
          ip: entry.address,
          url: `http://${entry.address}:${PORT}`
        });
      }
    });
  });

  res.json({
    port: PORT,
    addresses
  });
});

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_SEGMENTS = [3, 4, 3];

function generateSecureRoomId() {
  const segments = ROOM_CODE_SEGMENTS.map((segmentLength) => {
    let segment = '';
    for (let index = 0; index < segmentLength; index += 1) {
      segment += ROOM_CODE_ALPHABET[crypto.randomInt(0, ROOM_CODE_ALPHABET.length)];
    }
    return segment;
  });

  return segments.join('-');
}

async function generateUniqueRoomId(maxAttempts = 20) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateSecureRoomId();
    if (rooms.has(candidate)) {
      continue;
    }

    const existingSession = await database.getSession(candidate);
    if (!existingSession) {
      return candidate;
    }
  }

  throw new Error('Unable to generate a unique room code');
}

function sanitizeRoomId(roomId = '') {
  return String(roomId).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
}

function getSocketConnectionAddress(socket) {
  const forwardedFor = socket?.handshake?.headers?.['x-forwarded-for'];
  const candidate = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : String(forwardedFor || socket?.handshake?.address || socket?.conn?.remoteAddress || '').split(',')[0].trim();

  return candidate.replace(/^::ffff:/, '') || 'unknown';
}

function deleteFeedbackFiles(relativePaths = []) {
  const deletedPaths = [];
  for (const relativePath of relativePaths) {
    if (!relativePath) continue;
    const normalized = String(relativePath).replace(/^\/+/, '');
    const absolutePath = path.join(__dirname, normalized);
    if (!absolutePath.startsWith(UPLOADS_DIR)) {
      continue;
    }
    try {
      if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath);
        deletedPaths.push(relativePath);
      }
    } catch (error) {
      console.error(`Failed to remove feedback upload ${relativePath}:`, error.message);
    }
  }
  return deletedPaths;
}

const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const ADMIN_ACTION_CODE = String(process.env.ADMIN_ACTION_CODE || ADMIN_PASSWORD);
const ADMIN_SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS || 1000 * 60 * 60 * 12);
const DATA_RETENTION_DAYS = Math.max(1, Number(process.env.DATA_RETENTION_DAYS || 30));
const DATA_RETENTION_INTERVAL_MS = Math.max(60 * 60 * 1000, Number(process.env.DATA_RETENTION_INTERVAL_MS || 24 * 60 * 60 * 1000));
const adminSessions = new Map();

function normalizeAdminUsername(username = '') {
  return String(username).trim().toLowerCase();
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), String(salt), 120000, 64, 'sha512').toString('hex');
}

function isSecureEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readBearerToken(req) {
  const authHeader = req.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function issueAdminToken(adminId, username) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  adminSessions.set(token, { adminId, username, expiresAt });
  return { token, expiresAt };
}

async function ensureDefaultAdminAccount() {
  const existing = await database.getAdminByUsername(ADMIN_USERNAME);
  if (existing) return existing;

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(ADMIN_PASSWORD, salt);
  const adminId = await database.createAdmin(ADMIN_USERNAME, passwordHash, salt);
  console.log(`Default admin account created. Username: ${ADMIN_USERNAME}`);
  return { id: adminId, username: ADMIN_USERNAME };
}

async function requireAdminAuth(req, res, next) {
  const token = readBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  const session = adminSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    adminSessions.delete(token);
    return res.status(401).json({ error: 'Admin session expired. Please login again.' });
  }

  const admin = await database.get(
    'SELECT id, username FROM admin_users WHERE id = ?',
    [session.adminId]
  );
  if (!admin) {
    adminSessions.delete(token);
    return res.status(401).json({ error: 'Admin account not found' });
  }

  req.admin = admin;
  req.adminToken = token;
  return next();
}

function requireAdminActionCode(req, res, next) {
  const suppliedCode = String(req.body?.confirmationCode || req.get('x-admin-action-code') || '').trim();
  if (!suppliedCode) {
    return res.status(400).json({ error: 'Admin confirmation code is required' });
  }

  if (!isSecureEqual(suppliedCode, ADMIN_ACTION_CODE)) {
    return res.status(403).json({ error: 'Invalid admin confirmation code' });
  }

  return next();
}

function validatePresenterDetails(details = {}) {
  if (!String(details.name || '').trim()) return 'Presenter name is required';
  if (!String(details.email || '').trim()) return 'Presenter email is required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(details.email || '').trim())) return 'Enter a valid presenter email';
  if (!String(details.topic || details.title || '').trim()) return 'Lecture topic is required';
  if (!String(details.department || details.dept || '').trim()) return 'Department is required';
  if (!String(details.room || '').trim()) return 'Physical room or lab is required';
  return null;
}

function validateStudentDetails(details = {}) {
  if (!String(details.name || '').trim()) return 'Student name is required';
  if (!String(details.email || '').trim()) return 'Student email is required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(details.email || '').trim())) return 'Enter a valid student email';
  if (!String(details.roomId || '').trim()) return 'Room ID is required';
  return null;
}

async function runRetentionCleanup(retentionDays = DATA_RETENTION_DAYS) {
  const summary = await database.purgeExpiredData(retentionDays);
  const deletedUploads = deleteFeedbackFiles(summary.screenshotPaths || []);
  return {
    ...summary,
    deletedUploads
  };
}

app.post('/api/room-id', async (req, res) => {
  const { presenterDetails } = req.body || {};
  if (!presenterDetails || typeof presenterDetails !== 'object') {
    return res.status(400).json({ error: 'Presenter details are required' });
  }

  const presenterValidationError = validatePresenterDetails(presenterDetails);
  if (presenterValidationError) {
    return res.status(400).json({ error: presenterValidationError });
  }

  try {
    const generatedRoomId = await generateUniqueRoomId();
    return res.json({ roomId: generatedRoomId });
  } catch (error) {
    console.error('Failed to generate secure room code:', error);
    return res.status(500).json({ error: 'Room ID could not be generated' });
  }
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const username = normalizeAdminUsername(req.body?.username);
    const password = String(req.body?.password || '');
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const admin = await database.getAdminByUsername(username);
    if (!admin) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }

    const computedHash = hashPassword(password, admin.salt);
    if (!isSecureEqual(computedHash, admin.password_hash)) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }

    await database.updateAdminLastLogin(admin.id);
    const { token, expiresAt } = issueAdminToken(admin.id, admin.username);
    return res.json({
      success: true,
      token,
      username: admin.username,
      expiresAt
    });
  } catch (error) {
    console.error('Error during admin login:', error);
    return res.status(500).json({ error: 'Failed to login admin' });
  }
});

app.get('/api/admin/me', requireAdminAuth, async (req, res) => {
  return res.json({
    authenticated: true,
    username: req.admin.username
  });
});

app.post('/api/admin/logout', requireAdminAuth, async (req, res) => {
  adminSessions.delete(req.adminToken);
  return res.json({ success: true });
});

// API Routes for Admin Dashboard
app.get('/api/stats', requireAdminAuth, async (req, res) => {
  try {
    const stats = await database.get(`
      SELECT 
        (SELECT COUNT(*) FROM users) as totalUsers,
        (SELECT COUNT(*) FROM sessions) as totalSessions,
        (SELECT COUNT(*) FROM sessions WHERE status = 'active') as activeSessions,
        (SELECT COUNT(*) FROM performance_logs) as totalLogs
    `);
    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/api/sessions', requireAdminAuth, async (req, res) => {
  try {
    const { status, search } = req.query;
    let query = 'SELECT * FROM sessions';
    const params = [];
    
    if (status || search) {
      query += ' WHERE';
      const conditions = [];
      
      if (status) {
        conditions.push(' status = ?');
        params.push(status);
      }
      
      if (search) {
        conditions.push(' (room_id LIKE ? OR presenter_name LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
      }
      
      query += conditions.join(' AND');
    }
    
    query += ' ORDER BY created_at DESC';
    
    const sessions = await database.all(query, params);
    res.json(sessions);
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

app.get('/api/users', requireAdminAuth, async (req, res) => {
  try {
    const { role, search } = req.query;
    let query = 'SELECT * FROM users';
    const params = [];
    
    if (role || search) {
      query += ' WHERE';
      const conditions = [];
      
      if (role) {
        conditions.push(' role = ?');
        params.push(role);
      }
      
      if (search) {
        conditions.push(' (name LIKE ? OR email LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
      }
      
      query += conditions.join(' AND');
    }
    
    query += ' ORDER BY created_at DESC';
    
    const users = await database.all(query, params);
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/api/session/:id/stats', requireAdminAuth, async (req, res) => {
  try {
    const stats = await database.getSessionStats(req.params.id);
    res.json(stats);
  } catch (error) {
    console.error('Error fetching session stats:', error);
    res.status(500).json({ error: 'Failed to fetch session stats' });
  }
});

// Attendance endpoints
app.get('/api/session/:roomId/attendance', async (req, res) => {
  try {
    const session = await database.getSession(req.params.roomId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const attendance = await database.getSessionAttendance(session.id);
    res.json(attendance);
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

app.get('/api/session/:roomId/attendance/export', async (req, res) => {
  try {
    const session = await database.getSession(req.params.roomId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const csv = await database.exportAttendanceCSV(session.id);
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${session.room_id}_${Date.now()}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting attendance:', error);
    res.status(500).json({ error: 'Failed to export attendance' });
  }
});

// Real-time monitoring endpoints
app.get('/api/admin/overview', requireAdminAuth, async (req, res) => {
  try {
    const activeRooms = Array.from(rooms.entries()).map(([roomId, room]) => ({
      roomId,
      presenterName: room.presenterDetails.name,
      presenterEmail: room.presenterDetails.email,
      studentCount: room.students.size,
      status: room.status,
      createdAt: room.createdAt,
      sessionId: room.sessionId
    }));

    const totalSessions = await database.get('SELECT COUNT(*) as count FROM sessions WHERE status = "active"');
    const totalUsers = await database.get('SELECT COUNT(*) as count FROM users');
    const totalAttendance = await database.get('SELECT COUNT(*) as count FROM attendance');

    res.json({
      activeRooms,
      stats: {
        activeSessions: totalSessions.count,
        totalUsers: totalUsers.count,
        totalAttendance: totalAttendance.count,
        connectedClients: io.engine.clientsCount
      }
    });
  } catch (error) {
    console.error('Error fetching admin overview:', error);
    res.status(500).json({ error: 'Failed to fetch overview' });
  }
});

app.get('/api/admin/room/:roomId/details', requireAdminAuth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = rooms.get(roomId);
    
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const participants = Array.from((participants.get(roomId) || new Map()).values());
    const session = await database.getSession(roomId);
    const attendance = session ? await database.getSessionAttendance(session.id) : [];

    res.json({
      room: {
        roomId,
        presenterName: room.presenterDetails.name,
        presenterEmail: room.presenterDetails.email,
        status: room.status,
        createdAt: room.createdAt,
        studentCount: room.students.size
      },
      participants,
      attendance,
      chatHistory: chatMessages.get(roomId) || []
    });
  } catch (error) {
    console.error('Error fetching room details:', error);
    res.status(500).json({ error: 'Failed to fetch room details' });
  }
});

app.get('/api/admin/recent-activity', requireAdminAuth, async (req, res) => {
  try {
    const recentSessions = await database.all(`
      SELECT s.*, u.name as presenter_name, u.email as presenter_email
      FROM sessions s
      JOIN users u ON s.presenter_id = u.id
      ORDER BY s.created_at DESC
      LIMIT 10
    `);

    const recentUsers = await database.all(`
      SELECT name, email, role, created_at, last_active
      FROM users
      ORDER BY last_active DESC
      LIMIT 10
    `);

    res.json({
      recentSessions,
      recentUsers
    });
  } catch (error) {
    console.error('Error fetching recent activity:', error);
    res.status(500).json({ error: 'Failed to fetch recent activity' });
  }
});

app.get('/api/admin/performance-logs', requireAdminAuth, async (req, res) => {
  try {
    const { sessionId, logType, limit = 100 } = req.query;
    
    const logs = await database.getPerformanceLogs(sessionId, logType, parseInt(limit));
    res.json(logs);
  } catch (error) {
    console.error('Error fetching performance logs:', error);
    res.status(500).json({ error: 'Failed to fetch performance logs' });
  }
});

app.get('/api/admin/performance-stats', requireAdminAuth, async (req, res) => {
  try {
    const { sessionId } = req.query;
    
    const stats = await database.getPerformanceStats(sessionId);
    res.json(stats);
  } catch (error) {
    console.error('Error fetching performance stats:', error);
    res.status(500).json({ error: 'Failed to fetch performance stats' });
  }
});

// Performance logging API endpoint
app.post('/api/performance-log', async (req, res) => {
  try {
    const { roomId, participantId, logType, message, metrics } = req.body;
    
    if (!roomId || !logType || !message) {
      return res.status(400).json({ error: 'Room ID, log type, and message are required' });
    }

    // Get session ID from room ID
    const session = await database.getSession(roomId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const resolvedParticipantId = await resolveParticipantDbId(roomId, participantId);
    if (shouldSkipPerformanceLog(session.id, resolvedParticipantId, logType, message)) {
      return res.json({
        success: true,
        skipped: true,
        message: 'Performance log throttled'
      });
    }

    // Log performance data
    await database.logPerformance(
      session.id,
      resolvedParticipantId,
      logType,
      message,
      metrics || {}
    );

    res.json({ 
      success: true, 
      message: 'Performance log recorded successfully' 
    });
  } catch (error) {
    console.error('Error logging performance:', error);
    res.status(500).json({ error: 'Failed to log performance data' });
  }
});

// Simplified Feedback API endpoints
app.post('/api/feedback', async (req, res) => {
  try {
    const { email, name, role, rating, message, issueType, description, screenshot, feedbackType, subject, sessionId } = req.body;
    if (!issueType) {
      return res.status(400).json({ error: 'Issue type is required' });
    }
    if (!description && !message) {
      return res.status(400).json({ error: 'Issue description is required' });
    }
    if (!rating) {
      return res.status(400).json({ error: 'Rating is required' });
    }

    let user = email ? await database.getUserByEmail(email) : null;

    if (!user) {
      if (!name) {
        return res.status(400).json({ error: 'User name is required' });
      }

      const createdUserId = await database.createUser(
        name,
        email || null,
        role === 'presenter' ? 'presenter' : 'student',
        null
      );

      user = { id: createdUserId };
    }

    const savedScreenshot = saveFeedbackScreenshot(screenshot);

    const payload = {
      message: message || description || null,
      feedbackType: feedbackType || (issueType ? 'bug_report' : 'general'),
      sessionId: sessionId || null,
      subject: subject || issueType || 'Screen sharing issue',
      issueType: issueType || null,
      description: description || message || null,
      screenshotName: savedScreenshot?.fileName || screenshot?.name || null,
      screenshotType: screenshot?.type || null,
      screenshotPath: savedScreenshot?.relativePath || null,
      status: 'pending'
    };

    const feedbackId = await database.submitFeedback(user.id, rating, payload);

    res.json({ 
      success: true, 
      feedbackId,
      message: 'Feedback submitted successfully' 
    });
  } catch (error) {
    console.error('Error submitting feedback:', error);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

app.get('/api/admin/feedback', requireAdminAuth, async (req, res) => {
  try {
    const { limit = 100 } = req.query;
    
    const feedback = await database.getFeedback(parseInt(limit));
    
    res.json(feedback);
  } catch (error) {
    console.error('Error fetching feedback:', error);
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

app.get('/api/admin/feedback-stats', requireAdminAuth, async (req, res) => {
  try {
    const stats = await database.getFeedbackStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching feedback stats:', error);
    res.status(500).json({ error: 'Failed to fetch feedback stats' });
  }
});

app.post('/api/admin/feedback/:id/status', requireAdminAuth, async (req, res) => {
  try {
    const nextStatus = String(req.body?.status || '').trim().toLowerCase();
    if (!['pending', 'viewed', 'resolved'].includes(nextStatus)) {
      return res.status(400).json({ error: 'Invalid feedback status' });
    }

    await database.updateFeedbackStatus(req.params.id, nextStatus);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating feedback status:', error);
    res.status(500).json({ error: 'Failed to update feedback status' });
  }
});

app.post('/api/admin/maintenance/cleanup', requireAdminAuth, requireAdminActionCode, async (req, res) => {
  try {
    const requestedDays = Number(req.body?.retentionDays);
    const summary = await runRetentionCleanup(Number.isFinite(requestedDays) ? requestedDays : DATA_RETENTION_DAYS);
    res.json({ success: true, summary });
  } catch (error) {
    console.error('Error running retention cleanup:', error);
    res.status(500).json({ error: 'Failed to run retention cleanup' });
  }
});

app.post('/api/admin/maintenance/wipe', requireAdminAuth, requireAdminActionCode, async (req, res) => {
  try {
    const feedbackRows = await database.getFeedback(100000);
    const deletedUploads = deleteFeedbackFiles(feedbackRows.map((row) => row.screenshot_path));
    const clearedTables = await database.wipeOperationalData();
    res.json({ success: true, clearedTables, deletedUploads });
  } catch (error) {
    console.error('Error wiping operational data:', error);
    res.status(500).json({ error: 'Failed to wipe operational data' });
  }
});

app.post('/api/admin/maintenance/delete-table', requireAdminAuth, requireAdminActionCode, async (req, res) => {
  try {
    const tableName = String(req.body?.tableName || '').trim().toLowerCase();
    if (!tableName) {
      return res.status(400).json({ error: 'Table name is required' });
    }

    let screenshotPaths = [];
    if (['user_feedback', 'sessions', 'users'].includes(tableName)) {
      const feedbackRows = await database.getFeedback(100000);
      screenshotPaths = feedbackRows.map((row) => row.screenshot_path).filter(Boolean);
    }

    const clearedTables = await database.deleteTableContents(tableName);
    const deletedUploads = deleteFeedbackFiles(screenshotPaths);
    res.json({ success: true, clearedTables, deletedUploads });
  } catch (error) {
    console.error('Error deleting table contents:', error);
    res.status(500).json({ error: error.message || 'Failed to delete table contents' });
  }
});

/**
 * Room and Participant Storage
 * In an offline system, we keep this in memory for speed.
 * 'rooms' stores metadata about each active lecture.
 * 'participants' stores details about students in each room.
 * 'chatMessages' stores chat history for each room.
 */
const rooms = new Map();
const participants = new Map(); // roomId -> Map of socketId -> studentDetails
const chatMessages = new Map(); // roomId -> Array of chat messages
const MESH_WARNING_MEDIUM = Number(process.env.MESH_WARNING_MEDIUM || 10);
const MESH_WARNING_LARGE = Number(process.env.MESH_WARNING_LARGE || 18);
const MESH_WARNING_XLARGE = Number(process.env.MESH_WARNING_XLARGE || 28);
const PERFORMANCE_LOG_INTERVAL_MS = Number(process.env.PERFORMANCE_LOG_INTERVAL_MS || 10000);
const performanceLogTracker = new Map();

async function resolveParticipantDbId(roomId, participantReference) {
  if (participantReference === null || participantReference === undefined || participantReference === '') {
    return null;
  }

  if (Number.isInteger(participantReference)) {
    return participantReference;
  }

  const numericId = Number(participantReference);
  if (Number.isInteger(numericId) && String(participantReference).trim() === String(numericId)) {
    const user = await database.get('SELECT id FROM users WHERE id = ?', [numericId]);
    return user?.id || null;
  }

  const room = rooms.get(roomId);
  if (room) {
    if (room.presenterId === participantReference) {
      return room.presenterDbId || null;
    }

    const roomParticipants = participants.get(roomId);
    if (roomParticipants?.has(participantReference)) {
      return roomParticipants.get(participantReference)?.dbId || null;
    }
  }

  const user = await database.getUserBySocketId(String(participantReference));
  return user?.id || null;
}

function shouldSkipPerformanceLog(sessionId, participantId, logType, message) {
  if (logType !== 'performance') {
    return false;
  }

  const key = `${sessionId}:${participantId || 'system'}:${message}`;
  const now = Date.now();
  const previousLoggedAt = performanceLogTracker.get(key) || 0;
  if (now - previousLoggedAt < PERFORMANCE_LOG_INTERVAL_MS) {
    return true;
  }

  performanceLogTracker.set(key, now);
  return false;
}

function getScaleProfile(participantCount) {
  if (participantCount >= MESH_WARNING_XLARGE) {
    return {
      level: 'xlarge',
      recommendation: 'Very large class: hard presentation mode is active. Keep one speaker on mic and avoid motion-heavy content.',
      presentationMode: true,
      hardMode: true,
      allowTypingIndicators: false,
      allowStudentProjection: false,
      allowSystemAudio: false
    };
  }
  if (participantCount >= MESH_WARNING_LARGE) {
    return {
      level: 'large',
      recommendation: 'Large class: presentation mode is active. Prioritize slides, mic narration, and host-led sharing only.',
      presentationMode: true,
      hardMode: false,
      allowTypingIndicators: false,
      allowStudentProjection: false,
      allowSystemAudio: false
    };
  }
  if (participantCount >= MESH_WARNING_MEDIUM) {
    return {
      level: 'medium',
      recommendation: 'Medium class: adaptive quality mode is active for stable delivery.',
      presentationMode: true,
      hardMode: false,
      allowTypingIndicators: true,
      allowStudentProjection: true,
      allowSystemAudio: true
    };
  }
  return {
    level: 'small',
    recommendation: 'Normal class size: full quality mode is active.',
    presentationMode: false,
    hardMode: false,
    allowTypingIndicators: true,
    allowStudentProjection: true,
    allowSystemAudio: true
  };
}

function emitScaleProfile(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const participantCount = room.students.size + 1; // include presenter
  const profile = getScaleProfile(participantCount);

  io.to(roomId).emit('class-scale-update', {
    roomId,
    participantCount,
    level: profile.level,
    recommendation: profile.recommendation,
    presentationMode: profile.presentationMode,
    hardMode: profile.hardMode,
    allowTypingIndicators: profile.allowTypingIndicators,
    allowStudentProjection: profile.allowStudentProjection,
    allowSystemAudio: profile.allowSystemAudio,
    thresholds: {
      medium: MESH_WARNING_MEDIUM,
      large: MESH_WARNING_LARGE,
      xlarge: MESH_WARNING_XLARGE
    }
  });
}

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // Send list of existing rooms to the new connection (Simulated Bluetooth Scan)
  rooms.forEach((room, roomId) => {
    socket.emit('room-available', { 
      roomId, 
      details: room.presenterDetails 
    });
  });

  /**
   * CREATE ROOM
   * Called by the presenter. 
   * Generates or registers a room with specific metadata.
   */
  socket.on('create-room', async (data) => {
    const { roomId, presenterDetails } = data || {};
    const normalizedPresenterDetails = {
      ...presenterDetails,
      name: String(presenterDetails?.name || '').trim(),
      email: presenterDetails?.email && String(presenterDetails.email).trim()
        ? String(presenterDetails.email).trim().toLowerCase()
        : null,
      topic: String(presenterDetails?.topic || presenterDetails?.title || '').trim(),
      department: String(presenterDetails?.department || presenterDetails?.dept || '').trim(),
      room: String(presenterDetails?.room || '').trim()
    };
    const presenterValidationError = validatePresenterDetails(normalizedPresenterDetails);

    if (presenterValidationError) {
      console.error(`Invalid room creation attempt by ${socket.id}`);
      socket.emit('room-error', presenterValidationError);
      return;
    }

    try {
      let resolvedRoomId = sanitizeRoomId(roomId || '');
      const existingSession = resolvedRoomId ? await database.getSession(resolvedRoomId) : null;

      if (!resolvedRoomId || rooms.has(resolvedRoomId) || existingSession) {
        resolvedRoomId = await generateUniqueRoomId();
      }

      const connectionAddress = getSocketConnectionAddress(socket);
      // Check if presenter already exists in database
      let presenterId;
      const existingPresenter = normalizedPresenterDetails.email
        ? await database.getUserByEmail(normalizedPresenterDetails.email)
        : null;
      
      if (existingPresenter) {
        // Update existing presenter's socket and last active
        presenterId = existingPresenter.id;
        await database.updateUserSocket(presenterId, connectionAddress);
      } else {
        // Create new presenter if doesn't exist
        presenterId = await database.createUser(
          normalizedPresenterDetails.name, 
          normalizedPresenterDetails.email || null, 
          'presenter', 
          connectionAddress
        );
      }

      // Create session in database
      const sessionId = await database.createSession(
        resolvedRoomId, 
        presenterId, 
        normalizedPresenterDetails.name, 
        normalizedPresenterDetails.title || normalizedPresenterDetails.topic || null
      );

      socket.join(resolvedRoomId);
      
      // Store room with metadata for students to see
      rooms.set(resolvedRoomId, {
        presenterId: socket.id,
        presenterDetails: normalizedPresenterDetails,
        students: new Set(),
        createdAt: new Date(),
        status: 'active',
        sessionId: sessionId, // Store database session ID
        presenterDbId: presenterId, // Store database presenter ID
        activeSharerSocketId: null,
        activeSharerName: null,
        activeSharerRole: null
      });
      
      console.log(`Room [${resolvedRoomId}] created by ${normalizedPresenterDetails.name || 'Unknown'}`);
      
      socket.emit('room-created', { roomId: resolvedRoomId, details: normalizedPresenterDetails });
      emitScaleProfile(resolvedRoomId);
      
      // Broadcast that a new room is available (for discovery)
      socket.broadcast.emit('room-available', { roomId: resolvedRoomId, details: normalizedPresenterDetails });
      
      await database.logPerformance(sessionId, presenterId, 'info', `Room ${resolvedRoomId} created by ${normalizedPresenterDetails.name}`, {
        roomDetails: normalizedPresenterDetails,
        sessionId: sessionId
      });
      
      await database.logConnectionEvent(sessionId, presenterId, 'room_created', {
        roomId: resolvedRoomId,
        presenterName: normalizedPresenterDetails.name
      });
    } catch (error) {
      console.error('Error creating room in database:', error);
      socket.emit('room-error', 'Failed to create room: Database error');
      await database.logError(null, null, 'room_creation_error', error.message, { error });
    }
  });

  /**
   * JOIN ROOM
   * Called by a student.
   * Handles registration and duplicate prevention.
   */
  socket.on('join-room', async (data) => {
    console.log('Received join-room request:', data);
    
    const { roomId, studentInfo } = data || {};
    
    // Handle both formats: direct student details or wrapped in studentInfo
    const studentDetails = studentInfo || data;
    
    console.log('Extracted student details:', studentDetails);
    
    const requestedRoomId = sanitizeRoomId(roomId || studentDetails?.roomId || '');

    if (!requestedRoomId || !studentDetails) {
      console.log('Invalid join request - missing roomId or studentDetails');
      socket.emit('room-error', 'Room ID is required');
      return;
    }

    const normalizedStudentDetails = {
      ...studentDetails,
      name: String(studentDetails.name || '').trim(),
      email: String(studentDetails.email || '').trim().toLowerCase(),
      roomId: requestedRoomId
    };
    const studentValidationError = validateStudentDetails(normalizedStudentDetails);
    if (studentValidationError) {
      socket.emit('room-error', studentValidationError);
      return;
    }

    try {
      if (rooms.has(requestedRoomId)) {
        const room = rooms.get(requestedRoomId);
        socket.join(requestedRoomId);
        room.students.add(socket.id);
        const connectionAddress = getSocketConnectionAddress(socket);
        
        // Check if user already exists in database
        let studentId;
        const existingUser = await database.getUserByEmail(normalizedStudentDetails.email);
        
        if (existingUser) {
          // Update existing user's socket and last active
          studentId = existingUser.id;
          await database.updateUserSocket(studentId, connectionAddress);
        } else {
          // Create new user if doesn't exist
          studentId = await database.createUser(
            normalizedStudentDetails.name,
            normalizedStudentDetails.email || null,
            'student',
            connectionAddress
          );
        }
        
        if (!participants.has(requestedRoomId)) {
          participants.set(requestedRoomId, new Map());
        }
        
        const roomParticipants = participants.get(requestedRoomId);
        
        // Prevent duplicate email registrations in the same room
        let isDuplicate = false;
        for (const [id, p] of roomParticipants) {
          if (p.email === normalizedStudentDetails.email) {
            isDuplicate = true;
            break;
          }
        }
        
        if (isDuplicate) {
          socket.emit('room-error', 'This email is already registered in this room');
          return;
        }
        
        // Register student in memory
        roomParticipants.set(socket.id, {
          socketId: socket.id,
          name: normalizedStudentDetails.name,
          email: normalizedStudentDetails.email,
          ipAddress: connectionAddress,
          joinedAt: new Date(),
          role: 'student',
          dbId: studentId // Store database student ID
        });

        // Update participant count in database
        await database.updateParticipantCount(requestedRoomId, roomParticipants.size);

        // Mark attendance for the student
        await database.markAttendance(room.sessionId, studentId);

        console.log(`Student ${normalizedStudentDetails.name} joined room ${requestedRoomId}`);
        
        // Send presenter details back to student
        socket.emit('room-joined', {
          roomId: requestedRoomId,
          presenterDetails: room.presenterDetails,
          studentName: normalizedStudentDetails.name
        });

        // Notify presenter about the new student
        io.to(room.presenterId).emit('student-joined', socket.id);
        
        // Send updated participants list to everyone in the room
        const participantsList = Array.from(roomParticipants.values());
        io.to(requestedRoomId).emit('participants-updated', participantsList);
        emitScaleProfile(requestedRoomId);
        
        // Tell student who the presenter is for direct signaling
        socket.emit('presenter-info', { presenterId: room.presenterId });
      } else {
        socket.emit('room-error', 'Room not found. Please check the ID.');
      }
    } catch (error) {
      console.error('Error in join-room:', error);
      socket.emit('room-error', 'Failed to join room: Database error');
    }
  });

  /**
   * WEBRTC SIGNALING
   * These events act as a "switchboard" to pass connection data 
   * between peers (Offer/Answer/ICE) without the server seeing the video.
   */
  socket.on('request-student-projection', (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);
    const profile = room ? getScaleProfile(room.students.size + 1) : null;
    const isPresenter = room?.presenterId === socket.id;

    if (roomId && room && !isPresenter && !profile?.allowStudentProjection) {
      socket.emit('student-projection-disabled', {
        roomId,
        level: profile.level,
        message: 'Student screen sharing is disabled in presentation mode for larger classes.'
      });
      return;
    }

    if (roomId && room && (!room.activeSharerSocketId || room.activeSharerSocketId === socket.id)) {
      // Broadcast to everyone in the room except the sender
      socket.to(roomId).emit('student-projection-requested', { studentId: socket.id });
    }
  });

  socket.on('offer', (data) => {
    const { target, roomId, offer, isStudentScreen } = data;
    if (isStudentScreen && roomId) {
      // Broadcast to everyone in the room except the sender
      socket.to(roomId).emit('offer', { sender: socket.id, roomId, offer, isStudentScreen: true });
    } else if (target) {
      io.to(target).emit('offer', { sender: socket.id, roomId, offer });
    }
  });

  socket.on('answer', (data) => {
    const { target, roomId, answer } = data;
    io.to(target).emit('answer', { sender: socket.id, roomId, answer });
  });

  socket.on('ice-candidate', (data) => {
    const { target, candidate } = data;
    io.to(target).emit('ice-candidate', { sender: socket.id, candidate });
  });

  /**
   * SFU STREAMING (High Performance)
   * The SFU allows the server to manage the media flow better for many students.
   */
  socket.on('stream-register', (data) => {
    const { roomId, streamId, quality } = data;
    sfu.addStream(roomId, {
        id: streamId,
        roomId: roomId,
        quality: quality,
        presenterId: socket.id
    });
    socket.emit('stream-registered', { streamId, roomId });
  });

  socket.on('stream-subscribe', (data) => {
    const { streamId, roomId, quality } = data;
    sfu.addSubscriber(roomId, socket.id);
    sfu.sendStreamToSubscriber(socket.id, { id: streamId, roomId, quality });
  });

  socket.on('screen-stopped', (roomId) => {
    const room = rooms.get(roomId);
    if (room && room.activeSharerSocketId === socket.id) {
      room.activeSharerSocketId = null;
      room.activeSharerName = null;
      room.activeSharerRole = null;
    }
    socket.to(roomId).emit('screen-stopped', { senderId: socket.id });
  });

  /**
   * SCREEN SHARING EVENTS
   * Enforce one active sharer per room without content history tracking
   */
  socket.on('screen-share-start', async (data) => {
    const { roomId, shareType, contentTitle, contentDescription, slideCount, streamSettings } = data || {};
    
    try {
      const room = rooms.get(roomId);
      if (room && room.sessionId) {
        if (room.activeSharerSocketId && room.activeSharerSocketId !== socket.id) {
          socket.emit('screen-share-denied', {
            activeSharerName: room.activeSharerName || 'another participant',
            activeSharerRole: room.activeSharerRole || 'participant'
          });
          return;
        }

        const roomParticipants = participants.get(roomId);
        const participant = roomParticipants?.get(socket.id);
        const shareRole = socket.id === room.presenterId ? 'presenter' : 'student';
        const sharerName = shareRole === 'presenter'
          ? 'Host'
          : (participant?.name || room.activeSharerName || 'Student');
        const detectedType = shareType || await database.detectContentType(contentTitle, streamSettings);

        room.activeSharerSocketId = socket.id;
        room.activeSharerName = sharerName;
        room.activeSharerRole = shareRole;

        console.log(`Content share started: ${detectedType} - ${contentTitle || 'Untitled'} by ${sharerName}`);

        socket.to(roomId).emit('content-share-started', {
          shareType: detectedType,
          contentTitle,
          contentDescription,
          slideCount,
          presenterName: sharerName
        });
      }
    } catch (error) {
      console.error('Error tracking content share start:', error);
    }
  });

  socket.on('screen-share-update', async (data) => {
    const { shareId, currentSlide, contentTitle } = data || {};
    
    try {
      const room = Array.from(rooms.entries()).find(([, room]) => 
        room.students.has(socket.id) || room.presenterId === socket.id
      );

      if (room) {
        socket.to(room[0]).emit('content-share-updated', {
          shareId: shareId || null,
          currentSlide,
          contentTitle
        });
      }
    } catch (error) {
      console.error('Error updating content share:', error);
    }
  });

  socket.on('screen-share-stop', async () => {
    try {
      const room = Array.from(rooms.values()).find((candidateRoom) =>
        candidateRoom.activeSharerSocketId === socket.id
      );

      if (room) {
        room.activeSharerSocketId = null;
        room.activeSharerName = null;
        room.activeSharerRole = null;
      }

      const roomEntry = Array.from(rooms.entries()).find(([, room]) => 
        room.students.has(socket.id) || room.presenterId === socket.id
      );

      if (roomEntry) {
        socket.to(roomEntry[0]).emit('content-share-ended', {
          shareId: null
        });
      }
    } catch (error) {
      console.error('Error ending content share:', error);
    }
  });

  // Handle student screen sharing notifications
  socket.on('student-screen-share-started', (data) => {
    const { roomId } = data;
    const room = rooms.get(roomId);
    const profile = room ? getScaleProfile(room.students.size + 1) : null;

    if (room && !profile?.allowStudentProjection) {
      socket.emit('student-projection-disabled', {
        roomId,
        level: profile.level,
        message: 'Student screen sharing is disabled in presentation mode for larger classes.'
      });
      socket.emit('screen-share-denied', {
        activeSharerName: 'presentation mode',
        activeSharerRole: 'system policy'
      });
      return;
    }

    if (!room || (room.activeSharerSocketId && room.activeSharerSocketId !== socket.id)) {
      socket.emit('screen-share-denied', {
        activeSharerName: room?.activeSharerName || 'another participant',
        activeSharerRole: room?.activeSharerRole || 'participant'
      });
      return;
    }
    
    // Notify all other participants in the room to connect to this student
    socket.to(roomId).emit('student-projection-requested', {
      studentId: socket.id,
      roomId: roomId
    });
    
    console.log(`Student ${socket.id} started screen sharing in room ${roomId}`);
  });
  // Handle chat messages
  socket.on('chat-message', async (data) => {
    // Support both old format (message) and new format (text)
    const roomId = data.roomId || data.room;
    const messageText = data.text || data.message;
    const senderName = data.sender || data.senderName;
    const timestamp = data.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    console.log(`Chat message received from ${senderName}: ${messageText}`);
    console.log('Room ID from data:', roomId);
    console.log('Socket rooms:', socket.rooms);
    
    // Validate message data
    if (!messageText || !senderName) {
        console.error('Invalid chat message data - missing text or sender:', data);
        return;
    }
    
    // If roomId provided, use it. Otherwise try to get it from socket rooms
    let targetRoom = roomId;
    if (!targetRoom) {
        // Get the room this socket is in (excluding their own ID)
        const socketRooms = Array.from(socket.rooms).filter(r => r !== socket.id);
        if (socketRooms.length > 0) {
            targetRoom = socketRooms[0];
        }
    }
    
    if (!targetRoom) {
        console.error('No room found for chat message');
        return;
    }
    
    console.log(`Broadcasting to room: ${targetRoom}`);

    // Store message in room history
    if (!chatMessages.has(targetRoom)) {
        chatMessages.set(targetRoom, []);
    }
    const roomMessages = chatMessages.get(targetRoom);
    roomMessages.push({ sender: senderName, text: messageText, timestamp });
    
    // Broadcast message to all users in the room (excluding sender since they already displayed it)
    const broadcastData = {
        sender: senderName,
        text: messageText,
        timestamp: timestamp
    };
    
    // Use socket.to() to broadcast to others in the room (not including sender)
    socket.to(targetRoom).emit('chat-message', broadcastData);
    
    console.log(`Broadcasted chat message to ${targetRoom} (${roomMessages.length} total messages)`);
  });

  // Handle typing indicators
  socket.on('typing', (data) => {
    let roomId = data.roomId;
    
    // If no roomId provided, get from socket rooms
    if (!roomId) {
        const socketRooms = Array.from(socket.rooms).filter(r => r !== socket.id);
        if (socketRooms.length > 0) {
            roomId = socketRooms[0];
        }
    }
    
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (room && !getScaleProfile(room.students.size + 1).allowTypingIndicators) {
      return;
    }
    
    // Broadcast to room (except sender)
    socket.to(roomId).emit('typing', { sender: data.sender });
  });

  socket.on('stop-typing', (data) => {
    let roomId = data.roomId;
    
    // If no roomId provided, get from socket rooms
    if (!roomId) {
        const socketRooms = Array.from(socket.rooms).filter(r => r !== socket.id);
        if (socketRooms.length > 0) {
            roomId = socketRooms[0];
        }
    }
    
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (room && !getScaleProfile(room.students.size + 1).allowTypingIndicators) {
      return;
    }
    
    // Broadcast to room (except sender)
    socket.to(roomId).emit('stop-typing', { sender: data.sender });
  });

  /**
   * DISCONNECTION
   * Cleanup room data when users leave to free memory.
   */
  socket.on('disconnect', async () => {
    rooms.forEach(async (room, roomId) => {
      if (room.presenterId === socket.id) {
        // If presenter leaves, end session for everyone and clear all data
        socket.to(roomId).emit('presenter-disconnected');
        socket.to(roomId).emit('session-ended', { message: 'Presenter has ended the session' });
        
        // End session in database
        if (room.sessionId) {
          await database.endSession(roomId);
        }
        
        // Clear all session data
        rooms.delete(roomId);
        participants.delete(roomId);
        chatMessages.delete(roomId); // Clear chat history when session ends
        console.log(`Room ${roomId} closed: Presenter disconnected - All data cleared`);
      } else if (room.students.has(socket.id)) {
        if (room.activeSharerSocketId === socket.id) {
          room.activeSharerSocketId = null;
          room.activeSharerName = null;
          room.activeSharerRole = null;
          io.to(roomId).emit('screen-stopped', { senderId: socket.id });
        }

        // If student leaves, update participant list but keep session active
        room.students.delete(socket.id);
        const roomParticipants = participants.get(roomId);
        if (roomParticipants) {
          const studentData = roomParticipants.get(socket.id);
          roomParticipants.delete(socket.id);
          
          // Update participant count in database
          await database.updateParticipantCount(roomId, roomParticipants.size);
          
          // Update attendance when student leaves
          if (studentData && room.sessionId) {
            await database.updateAttendanceLeave(room.sessionId, studentData.dbId);
          }
          
          const list = Array.from(roomParticipants.values());
          io.to(roomId).emit('participants-updated', list); // Broadcast to entire room
          emitScaleProfile(roomId);
        }
        io.to(room.presenterId).emit('student-disconnected', socket.id);
      }
    });
  });
});

/**
 * SERVER STARTUP
 * The server listens on 0.0.0.0 to be accessible via Wi-Fi IP.
 */
const PORT = process.env.PORT || 3001;

// Initialize database before starting server
async function startServer() {
  try {
    await database.initialize();
    await ensureDefaultAdminAccount();
    try {
      const cleanupSummary = await runRetentionCleanup(DATA_RETENTION_DAYS);
      console.log('Retention cleanup completed on startup:', cleanupSummary.deleted);
    } catch (cleanupError) {
      console.error('Startup retention cleanup failed:', cleanupError);
    }
    console.log('Database initialized successfully.');
    
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`\n==================================================`);
      console.log(`OFFLINE LECTURE SYSTEM RUNNING`);
      console.log(`Access at: http://localhost:${PORT}`);
      console.log(`Or via Network: http://[YOUR-IP]:${PORT}`);
      console.log(`==================================================\n`);
    });

    setInterval(async () => {
      try {
        const cleanupSummary = await runRetentionCleanup(DATA_RETENTION_DAYS);
        console.log('Scheduled retention cleanup completed:', cleanupSummary.deleted);
      } catch (cleanupError) {
        console.error('Scheduled retention cleanup failed:', cleanupError);
      }
    }, DATA_RETENTION_INTERVAL_MS);
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  database.close();
  process.exit(0);
});

startServer();
