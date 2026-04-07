
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
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
const io = socketIo(server, {
  cors: {
    //origin: "*", // Allow all origins for local network access
    origin: ["https://must-mirror.vercel.app", "http://localhost:3001"],
    methods: ["GET", "POST"]
  }
});

// Initialize SFU with the socket.io instance
sfu.setIO(io);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve admin dashboard from root directory
app.get('/admin-dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-dashboard.html'));
});

// Serve feedback form from root directory
app.get('/feedback.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'feedback.html'));
});

// API Routes for Admin Dashboard
app.get('/api/stats', async (req, res) => {
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

app.get('/api/sessions', async (req, res) => {
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

app.get('/api/users', async (req, res) => {
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

app.get('/api/session/:id/stats', async (req, res) => {
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
app.get('/api/admin/overview', async (req, res) => {
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

app.get('/api/admin/room/:roomId/details', async (req, res) => {
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

app.get('/api/admin/recent-activity', async (req, res) => {
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

app.get('/api/admin/content-history', async (req, res) => {
  try {
    const { sessionId, limit = 50 } = req.query;
    
    let query = `
      SELECT cs.*, u.name as user_name, u.email as user_email, s.room_id
      FROM content_shares cs
      JOIN users u ON cs.user_id = u.id
      JOIN sessions s ON cs.session_id = s.id
    `;
    
    const params = [];
    
    if (sessionId) {
      query += ' WHERE cs.session_id = (SELECT id FROM sessions WHERE room_id = ?)';
      params.push(sessionId);
    }
    
    query += ' ORDER BY cs.started_at DESC LIMIT ?';
    params.push(limit);
    
    const contentHistory = await database.all(query, params);
    
    // Parse metadata for each record
    contentHistory.forEach(record => {
      if (record.content_metadata) {
        try {
          record.content_metadata = JSON.parse(record.content_metadata);
        } catch (e) {
          record.content_metadata = null;
        }
      }
    });
    
    res.json(contentHistory);
  } catch (error) {
    console.error('Error fetching content history:', error);
    res.status(500).json({ error: 'Failed to fetch content history' });
  }
});

app.get('/api/admin/performance-logs', async (req, res) => {
  try {
    const { sessionId, logType, limit = 100 } = req.query;
    
    const logs = await database.getPerformanceLogs(sessionId, logType, parseInt(limit));
    res.json(logs);
  } catch (error) {
    console.error('Error fetching performance logs:', error);
    res.status(500).json({ error: 'Failed to fetch performance logs' });
  }
});

app.get('/api/admin/performance-stats', async (req, res) => {
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

    // Log performance data
    await database.logPerformance(
      session.id,
      participantId || null,
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
    const { email, rating, message } = req.body;
    
    if (!email || !rating) {
      return res.status(400).json({ error: 'Email and rating are required' });
    }

    // Get user by email
    const user = await database.getUserByEmail(email);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Submit feedback
    const feedbackId = await database.submitFeedback(user.id, rating, message);

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

app.get('/api/admin/feedback', async (req, res) => {
  try {
    const { limit = 100 } = req.query;
    
    const feedback = await database.getFeedback(parseInt(limit));
    
    res.json(feedback);
  } catch (error) {
    console.error('Error fetching feedback:', error);
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

app.get('/api/admin/feedback-stats', async (req, res) => {
  try {
    const stats = await database.getFeedbackStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching feedback stats:', error);
    res.status(500).json({ error: 'Failed to fetch feedback stats' });
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
    
    if (!roomId || !presenterDetails) {
      console.error(`Invalid room creation attempt by ${socket.id}`);
      socket.emit('room-error', 'Failed to create room: Missing information');
      return;
    }

    try {
      // Check if presenter already exists in database
      let presenterId;
      const existingPresenter = await database.getUserByEmail(presenterDetails.email);
      
      if (existingPresenter) {
        // Update existing presenter's socket and last active
        presenterId = existingPresenter.id;
        await database.updateUserSocket(presenterId, socket.id);
      } else {
        // Create new presenter if doesn't exist
        presenterId = await database.createUser(
          presenterDetails.name, 
          presenterDetails.email || null, 
          'presenter', 
          socket.id
        );
      }

      // Create session in database
      const sessionId = await database.createSession(
        roomId, 
        presenterId, 
        presenterDetails.name, 
        presenterDetails.title || null
      );

      socket.join(roomId);
      
      // Store room with metadata for students to see
      rooms.set(roomId, {
        presenterId: socket.id,
        presenterDetails: presenterDetails,
        students: new Set(),
        createdAt: new Date(),
        status: 'active',
        sessionId: sessionId, // Store database session ID
        presenterDbId: presenterId // Store database presenter ID
      });
      
      console.log(`Room [${roomId}] created by ${presenterDetails.name || 'Unknown'}`);
      
      socket.emit('room-created', { roomId, details: presenterDetails });
      
      // Broadcast that a new room is available (for discovery)
      socket.broadcast.emit('room-available', { roomId, details: presenterDetails });
      
      await database.logPerformance(sessionId, presenterId, 'info', `Room ${roomId} created by ${presenterDetails.name}`, {
        roomDetails: presenterDetails,
        sessionId: sessionId
      });
      
      await database.logConnectionEvent(sessionId, presenterId, 'room_created', {
        roomId: roomId,
        presenterName: presenterDetails.name
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
    
    if (!roomId || !studentDetails) {
      console.log('Invalid join request - missing roomId or studentDetails');
      socket.emit('room-error', 'Invalid join request');
      return;
    }

    try {
      if (rooms.has(roomId)) {
        const room = rooms.get(roomId);
        socket.join(roomId);
        room.students.add(socket.id);
        
        // Check if user already exists in database
        let studentId;
        const existingUser = await database.getUserByEmail(studentDetails.email);
        
        if (existingUser) {
          // Update existing user's socket and last active
          studentId = existingUser.id;
          await database.updateUserSocket(studentId, socket.id);
        } else {
          // Create new user if doesn't exist
          studentId = await database.createUser(
            studentDetails.name,
            studentDetails.email || null,
            'student',
            socket.id
          );
        }
        
        if (!participants.has(roomId)) {
          participants.set(roomId, new Map());
        }
        
        const roomParticipants = participants.get(roomId);
        
        // Prevent duplicate email registrations in the same room
        let isDuplicate = false;
        for (const [id, p] of roomParticipants) {
          if (p.email === studentDetails.email) {
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
          name: studentDetails.name,
          email: studentDetails.email,
          joinedAt: new Date(),
          role: 'student',
          dbId: studentId // Store database student ID
        });

        // Update participant count in database
        await database.updateParticipantCount(roomId, roomParticipants.size);

        // Mark attendance for the student
        await database.markAttendance(room.sessionId, studentId);

        console.log(`Student ${studentDetails.name} joined room ${roomId}`);
        
        // Send presenter details back to student
        socket.emit('room-joined', {
          roomId: roomId,
          presenterDetails: room.presenterDetails,
          studentName: studentDetails.name
        });

        // Notify presenter about the new student
        io.to(room.presenterId).emit('student-joined', socket.id);
        
        // Send updated participants list to everyone in the room
        const participantsList = Array.from(roomParticipants.values());
        io.to(roomId).emit('participants-updated', participantsList);
        
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
    if (roomId) {
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
    socket.to(roomId).emit('screen-stopped', { senderId: socket.id });
  });

  /**
   * SCREEN SHARING EVENTS
   * Track content being shared with enhanced details
   */
  socket.on('screen-share-start', async (data) => {
    const { roomId, shareType, contentTitle, contentDescription, slideCount, streamSettings } = data || {};
    
    try {
      const room = rooms.get(roomId);
      if (room && room.sessionId) {
        // Get user info
        const user = await database.getUserBySocketId(socket.id);
        if (user) {
          // Enhanced content type detection using both title and stream settings
          const detectedType = shareType || await database.detectContentType(contentTitle, streamSettings);
          
          // Start content share tracking
          const shareId = await database.startContentShare(
            room.sessionId,
            user.id,
            detectedType,
            contentTitle,
            contentDescription,
            { windowTitle: contentTitle, streamSettings, userAgent: socket.handshake.headers['user-agent'] },
            slideCount
          );
          
          // Store share ID for this socket
          socket.currentContentShareId = shareId;
          
          console.log(`Content share started: ${detectedType} - ${contentTitle || 'Untitled'} (Share ID: ${shareId})`);
          
          // Notify room about content share
          socket.to(roomId).emit('content-share-started', {
            shareId,
            shareType: detectedType,
            contentTitle,
            contentDescription,
            slideCount,
            presenterName: user.name
          });
        }
      }
    } catch (error) {
      console.error('Error tracking content share start:', error);
    }
  });

  socket.on('screen-share-update', async (data) => {
    const { shareId, currentSlide, contentTitle } = data || {};
    
    try {
      if (shareId) {
        await database.updateContentShare(shareId, {
          current_slide: currentSlide,
          content_title: contentTitle
        });
        
        // Notify room about update
        const room = Array.from(rooms.entries()).find(([id, room]) => 
          room.students.has(socket.id) || room.presenterId === socket.id
        );
        
        if (room) {
          socket.to(room[0]).emit('content-share-updated', {
            shareId,
            currentSlide,
            contentTitle
          });
        }
      }
    } catch (error) {
      console.error('Error updating content share:', error);
    }
  });

  socket.on('screen-share-stop', async () => {
    try {
      if (socket.currentContentShareId) {
        await database.endContentShare(socket.currentContentShareId);
        console.log(`Content share ended: ${socket.currentContentShareId}`);
        
        // Notify room about content share end
        const room = Array.from(rooms.entries()).find(([id, room]) => 
          room.students.has(socket.id) || room.presenterId === socket.id
        );
        
        if (room) {
          socket.to(room[0]).emit('content-share-ended', {
            shareId: socket.currentContentShareId
          });
        }
        
        socket.currentContentShareId = null;
      }
    } catch (error) {
      console.error('Error ending content share:', error);
    }
  });

  // Handle student screen sharing notifications
  socket.on('student-screen-share-started', (data) => {
    const { roomId } = data;
    
    // Notify all other participants in the room to connect to this student
    socket.to(roomId).emit('student-projection-requested', {
      studentId: socket.id,
      roomId: roomId
    });
    
    console.log(`Student ${socket.id} started screen sharing in room ${roomId}`);
  });
  socket.on('chat-message', async (data) => {
    const { roomId, message, senderName, role, timestamp } = data;
    
    console.log(`Chat message received in ${roomId} from ${senderName} (${role}): ${message}`);
    
    // Validate message data
    if (!roomId || !message || !senderName) {
        console.error('Invalid chat message data:', data);
        return;
    }

    // Get room info
    const room = rooms.get(roomId);
    if (!room) {
        console.error(`Room ${roomId} not found for chat message`);
        return;
    }

    // Store message in room history (memory only - will be cleared when session ends)
    if (!chatMessages.has(roomId)) {
        chatMessages.set(roomId, []);
    }
    const roomMessages = chatMessages.get(roomId);
    roomMessages.push({ senderName, message, role, timestamp });
    
    // Broadcast message to all users in the room (including sender)
    // This ensures everyone sees the message at the same time
    io.to(roomId).emit('chat-message', { senderName, message, role, timestamp });
    
    console.log(`Broadcasted chat message to ${roomId} - ${roomMessages.length} total messages`);
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
    console.log('Database initialized successfully.');
    
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`\n==================================================`);
      console.log(`OFFLINE LECTURE SYSTEM RUNNING`);
      console.log(`Access at: http://localhost:${PORT}`);
      console.log(`Or via Network: http://[YOUR-IP]:${PORT}`);
      console.log(`==================================================\n`);
    });
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

