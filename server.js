
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

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
    origin: "*", // Allow all origins for local network access
    methods: ["GET", "POST"]
  }
});

// Initialize SFU with the socket.io instance
sfu.setIO(io);

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Room and Participant Storage
 * In an offline system, we keep this in memory for speed.
 * 'rooms' stores metadata about each active lecture.
 * 'participants' stores details about students in each room.
 */
const rooms = new Map();
const participants = new Map(); // roomId -> Map of socketId -> studentDetails

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
  socket.on('create-room', (data) => {
    const { roomId, presenterDetails } = data || {};
    
    if (!roomId || !presenterDetails) {
      console.error(`Invalid room creation attempt by ${socket.id}`);
      socket.emit('room-error', 'Failed to create room: Missing information');
      return;
    }

    socket.join(roomId);
    
    // Store room with metadata for students to see
    rooms.set(roomId, {
      presenterId: socket.id,
      presenterDetails: presenterDetails,
      students: new Set(),
      createdAt: new Date(),
      status: 'active'
    });
    
    console.log(`Room [${roomId}] created by ${presenterDetails.name || 'Unknown'}`);
    socket.emit('room-created', { roomId, details: presenterDetails });
    
    // Broadcast that a new room is available (for discovery)
    socket.broadcast.emit('room-available', { roomId, details: presenterDetails });
  });

  /**
   * JOIN ROOM
   * Called by a student.
   * Handles registration and duplicate prevention.
   */
  socket.on('join-room', (data) => {
    const { roomId, studentInfo } = data || {};
    
    if (!roomId || !studentInfo) {
      socket.emit('room-error', 'Invalid join request');
      return;
    }

    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      socket.join(roomId);
      room.students.add(socket.id);
      
      if (!participants.has(roomId)) {
        participants.set(roomId, new Map());
      }
      
      const roomParticipants = participants.get(roomId);
      
      // Prevent duplicate email registrations in the same room
      let isDuplicate = false;
      for (const [id, p] of roomParticipants) {
        if (p.email === studentInfo.email) {
          isDuplicate = true;
          break;
        }
      }

      if (isDuplicate) {
        socket.emit('room-error', 'Email already in use in this room');
        return;
      }

      // Save student details
      roomParticipants.set(socket.id, {
        ...studentInfo,
        socketId: socket.id,
        joinedAt: new Date(),
        role: 'student'
      });

      console.log(`Student ${studentInfo.name} joined room ${roomId}`);
      
      // Send presenter details back to student
      socket.emit('room-joined', {
        roomId: roomId,
        presenterDetails: room.presenterDetails
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
   * DISCONNECTION
   * Cleanup room data when users leave to free memory.
   */
  socket.on('disconnect', () => {
    rooms.forEach((room, roomId) => {
      if (room.presenterId === socket.id) {
        // If presenter leaves, close the room
        socket.to(roomId).emit('presenter-disconnected');
        rooms.delete(roomId);
        participants.delete(roomId);
        console.log(`Room ${roomId} closed: Presenter disconnected`);
      } else if (room.students.has(socket.id)) {
        // If student leaves, update participant list
        room.students.delete(socket.id);
        const roomParticipants = participants.get(roomId);
        if (roomParticipants) {
          roomParticipants.delete(socket.id);
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
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n==================================================`);
  console.log(`OFFLINE LECTURE SYSTEM RUNNING`);
  console.log(`Access at: http://localhost:${PORT}`);
  console.log(`Or via Network: http://[YOUR-IP]:${PORT}`);
  console.log(`==================================================\n`);
});

