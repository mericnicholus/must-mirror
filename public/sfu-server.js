// Simple Selective Forwarding Unit (SFU) for scalable screen sharing
class SFUServer {
    constructor() {
        this.streams = new Map(); // roomId -> {presenterId, stream, quality}
        this.subscribers = new Map(); // roomId -> Set of subscriber socket IDs
        this.peerConnections = new Map(); // roomId -> Map of subscriberId -> RTCPeerConnection
        this.io = null; // Will be set by server
    }

    // Set Socket.IO instance
    setIO(io) {
        this.io = io;
    }

    // Add stream (presenter)
    addStream(roomId, stream) {
        console.log(`SFU: Adding stream to room ${roomId}`);
        this.streams.set(roomId, stream);
        
        // Notify existing subscribers that stream is available
        const subscribers = this.subscribers.get(roomId) || new Set();
        subscribers.forEach(socketId => {
            this.sendStreamToSubscriber(socketId, stream);
        });
    }

    // Add subscriber (student)
    addSubscriber(roomId, socketId) {
        console.log(`SFU: Adding subscriber ${socketId} to room ${roomId}`);
        
        if (!this.subscribers.has(roomId)) {
            this.subscribers.set(roomId, new Set());
        }
        this.subscribers.get(roomId).add(socketId);

        // Send existing stream if available
        const stream = this.streams.get(roomId);
        if (stream) {
            this.sendStreamToSubscriber(socketId, stream);
        }
    }

    // Remove subscriber
    removeSubscriber(roomId, socketId) {
        console.log(`SFU: Removing subscriber ${socketId} from room ${roomId}`);
        const subscribers = this.subscribers.get(roomId);
        if (subscribers) {
            subscribers.delete(socketId);
        }
        
        // Clean up peer connection
        const roomConnections = this.peerConnections.get(roomId);
        if (roomConnections) {
            roomConnections.delete(socketId);
        }
    }

    // Remove stream (presenter disconnect)
    removeStream(roomId) {
        console.log(`SFU: Removing stream from room ${roomId}`);
        this.streams.delete(roomId);
        
        // Notify subscribers
        const subscribers = this.subscribers.get(roomId) || new Set();
        subscribers.forEach(socketId => {
            // Send stream ended signal
            if (this.io) {
                this.io.to(socketId).emit('stream-ended', { roomId });
            }
        });
        
        this.subscribers.delete(roomId);
        this.peerConnections.delete(roomId);
    }

    // Send stream to individual subscriber with quality control
    sendStreamToSubscriber(socketId, stream) {
        console.log(`SFU: Sending stream to subscriber ${socketId}`);
        
        // For now, we'll use WebRTC to send to each subscriber
        // In a full SFU, this would be media server forwarding
        const subscriberSocket = this.io?.sockets.sockets.get(socketId);
        if (subscriberSocket) {
            subscriberSocket.emit('stream-available', {
                streamId: stream.id,
                roomId: stream.roomId,
                presenterId: stream.presenterId
            });
        }
    }

    // Get room stats
    getRoomStats(roomId) {
        const stream = this.streams.get(roomId);
        const subscribers = this.subscribers.get(roomId) || new Set();
        
        return {
            hasStream: !!stream,
            subscriberCount: subscribers.size,
            streamQuality: stream?.quality || 'auto'
        };
    }
}

// Export for Node.js
module.exports = SFUServer;

// Global SFU instance (for browser compatibility)
const sfu = new SFUServer();
