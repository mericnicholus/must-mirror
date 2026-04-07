// Professional Presenter Logic

class Presenter {
    constructor() {
        this.socket = null;
        this.roomId = null;
        this.screenStream = null;
        this.micStream = null;
        this.peerConnections = new Map();
        this.isSharing = false;
        this.chatMessages = [];
        this.unreadCount = 0;
        this.performanceMonitors = new Map(); // Track performance monitors
        this.connectionStartTime = null;
    }

    initializeSocket() {
        // Connect to different servers based on environment
        const isProduction = window.location.hostname !== 'localhost';
        const serverUrl = isProduction 
            ? `http://${window.location.hostname}:3001` // Use current hostname with port 3001
            : 'http://localhost:3001'; // Updated to port 3001
        
        this.socket = io(serverUrl);
        
        this.socket.on('room-created', (data) => {
            this.roomId = data.roomId;
            app.updateSessionUI(this.roomId, 'Active');
            webrtcUtils.addLogMessage('logMessages', `Lecture Room Active: ${this.roomId}`, 'success');
            
            // Show QR code button, chat notification icon, and attendance export button
            document.getElementById('qrButtonContainer').style.display = 'block';
            document.getElementById('chatNotificationIcon').style.display = 'flex';
            document.getElementById('attendanceExportContainer').style.display = 'block';
        });

        this.socket.on('chat-message', (data) => {
            this.addChatMessage(data);
            // Show notification for new messages
            if (typeof showChatNotification === 'function') {
                showChatNotification();
            }
        });

        this.socket.on('student-joined', (studentId) => {
            webrtcUtils.addLogMessage('logMessages', 'Student joined class', 'info');
            this.connectToStudent(studentId);
        });

        this.socket.on('participants-updated', (list) => this.updateParticipantsUI(list));

        this.socket.on('student-projection-requested', (data) => {
            if (!this.peerConnections.has(data.studentId)) {
                this.connectToStudent(data.studentId);
            }
        });

        this.socket.on('student-screen-share-started', (data) => {
            console.log('Student started screen sharing:', data);
            webrtcUtils.addLogMessage('logMessages', `Student started sharing screen`, 'info');
        });

        this.socket.on('screen-stopped', (data) => {
            const video = document.getElementById('mainVideo');
            if (this.isSharing && this.screenStream) {
                video.srcObject = this.screenStream;
                video.style.display = 'block';
                document.getElementById('waitingMessage').style.display = 'none';
            } else {
                video.srcObject = null;
                document.getElementById('waitingMessage').style.display = 'flex';
            }
        });

        this.socket.on('answer', async (data) => {
            const pc = this.peerConnections.get(data.sender);
            if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        });

        this.socket.on('ice-candidate', async (data) => {
            const pc = this.peerConnections.get(data.sender);
            if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        });

        this.socket.on('offer', async (data) => {
            let pc = this.peerConnections.get(data.sender);
            if (!pc) {
                pc = webrtcUtils.createPeerConnection(); // Use WebRTC configuration
                this.peerConnections.set(data.sender, pc);
                
                pc.onicecandidate = (e) => {
                    if (e.candidate) this.socket.emit('ice-candidate', { target: data.sender, candidate: e.candidate });
                };

                pc.ontrack = (e) => {
                    console.log("Student screen received");
                    const video = document.getElementById('mainVideo');
                    video.srcObject = e.streams[0];
                    video.style.display = 'block';
                    document.getElementById('waitingMessage').style.display = 'none';
                };
            }

            if (data.offer) {
                // Add local tracks if we are sharing
                if (this.screenStream) {
                    this.screenStream.getTracks().forEach(t => {
                        if (!pc.getSenders().find(s => s.track === t)) {
                            pc.addTrack(t, this.screenStream);
                        }
                    });
                }
                if (this.micStream) {
                    this.micStream.getTracks().forEach(t => {
                        if (!pc.getSenders().find(s => s.track === t)) {
                            pc.addTrack(t, this.micStream);
                        }
                    });
                }

                await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                this.socket.emit('answer', { target: data.sender, roomId: this.roomId, answer });
            }
        });
    }

    createRoom() {
        const details = {
            name: document.getElementById('presName').value.trim(),
            topic: document.getElementById('presTopic').value.trim(),
            department: document.getElementById('presDept').value.trim(),
            room: document.getElementById('presRoom').value.trim()
        };

        if (!details.name || !details.topic) return alert("Missing Info!");

        const generatedId = `${details.department.substring(0,3).toUpperCase()}-${details.name.split(' ').pop().toUpperCase()}`;
        this.socket.emit('create-room', { roomId: generatedId, presenterDetails: details });
    }

    generateQRCode() {
        const currentUrl = window.location.origin + window.location.pathname;
        const joinUrl = `${currentUrl}?room=${this.roomId}`;
        
        // Set room ID in modal
        document.getElementById('qrModalRoomId').textContent = this.roomId;
        
        // Clear previous QR code
        document.getElementById('qrModalCode').innerHTML = '';
        
        // Generate QR code using qrcodejs
        new QRCode(document.getElementById('qrModalCode'), {
            text: joinUrl,
            width: 280,
            height: 280,
            colorDark: '#333399',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.H
        });
    }

    sendChatMessage(message) {
        if (!message.trim() || !this.roomId) {
            console.log('Presenter sendChatMessage blocked:', { message: message.trim(), roomId: this.roomId });
            return;
        }
        
        const chatData = {
            roomId: this.roomId,
            senderName: 'Host',
            message: message.trim(),
            role: 'presenter',
            timestamp: new Date().toISOString()
        };
        
        console.log('Presenter sending chat data:', chatData);
        this.socket.emit('chat-message', chatData);
        // Don't add to own messages - server will broadcast back
    }

    addChatMessage(data) {
        this.chatMessages.push(data);
        this.renderChatMessage(data);
        this.scrollToChatBottom();
    }

    renderChatMessage(data) {
        // Add to both chat containers
        const containers = ['chatMessages', 'chatMessagesRegular'];
        
        containers.forEach(containerId => {
            const messagesContainer = document.getElementById(containerId);
            if (!messagesContainer) return;
            
            const messageDiv = document.createElement('div');
            messageDiv.className = `chat-message ${data.role}`;
            
            const time = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            messageDiv.innerHTML = `
                <div class="chat-message-header">
                    <span class="chat-message-name">${data.senderName}</span>
                    <span class="chat-message-time">${time}</span>
                </div>
                <div class="chat-message-text">${data.message}</div>
            `;
            
            messagesContainer.appendChild(messageDiv);
        });
    }

    scrollToChatBottom() {
        const containers = ['chatMessages', 'chatMessagesRegular'];
        containers.forEach(containerId => {
            const messagesContainer = document.getElementById(containerId);
            if (messagesContainer) {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }
        });
    }

    clearChat() {
        this.chatMessages = [];
        const containers = ['chatMessages', 'chatMessagesRegular'];
        containers.forEach(containerId => {
            const messagesContainer = document.getElementById(containerId);
            if (messagesContainer) {
                messagesContainer.innerHTML = '';
            }
        });
    }

    endSession() {
        this.clearChat();
        document.getElementById('chatNotificationIcon').style.display = 'none';
        // Other cleanup logic...
    }

    async toggleMic(enabled) {
        if (enabled) {
            try {
                this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                const track = this.micStream.getAudioTracks()[0];
                this.peerConnections.forEach(pc => {
                    const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
                    if (sender) sender.replaceTrack(track);
                    else pc.addTrack(track, this.micStream);
                });
            } catch (e) { console.error("Mic Error", e); }
        } else if (this.micStream) {
            this.micStream.getTracks().forEach(t => t.stop());
            this.micStream = null;
        }
    }

    async startScreenShare() {
        try {
            this.screenStream = await navigator.mediaDevices.getDisplayMedia({ 
                video: true, 
                audio: true 
            });
            
            const video = document.getElementById('mainVideo');
            video.srcObject = this.screenStream;
            video.style.display = 'block';
            document.getElementById('waitingMessage').style.display = 'none';

            // Get screen/share information for tracking
            const screenTrack = this.screenStream.getVideoTracks()[0];
            const settings = screenTrack.getSettings();
            const trackLabel = screenTrack.label || 'Screen Share';
            
            // Detect content type and extract information
            let contentTitle = trackLabel;
            let contentDescription = `Screen resolution: ${settings.width}x${settings.height}`;
            let slideCount = null;
            
            // Try to detect if it's a presentation
            if (trackLabel.toLowerCase().includes('powerpoint') || 
                trackLabel.toLowerCase().includes('presentation') ||
                trackLabel.toLowerCase().includes('slide')) {
                
                contentDescription = 'Presentation being shared';
                // You could add slide detection logic here
            }
            
            // Send content tracking information to server
            this.socket.emit('screen-share-start', {
                roomId: this.roomId,
                shareType: 'screen', // Let server detect the actual type
                contentTitle: contentTitle,
                contentDescription: contentDescription,
                slideCount: slideCount,
                streamSettings: {
                    width: settings.width,
                    height: settings.height,
                    frameRate: settings.frameRate
                }
            });

            this.screenStream.getVideoTracks()[0].onended = () => {
                this.stopScreenShare();
            };

            // Add tracks to all existing peer connections
            this.peerConnections.forEach(async (pc, peerId) => {
                this.screenStream.getTracks().forEach(track => pc.addTrack(track, this.screenStream));
                if (this.micStream) {
                    this.micStream.getTracks().forEach(track => pc.addTrack(track, this.micStream));
                }
                
                // Renegotiate
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                this.socket.emit('offer', { target: peerId, roomId: this.roomId, offer });
            });

            // Notify everyone in the room
            this.socket.emit('request-student-projection', { roomId: this.roomId });
            
            webrtcUtils.addLogMessage('logMessages', `Started sharing: ${contentTitle}`, 'success');
            
        } catch (e) { 
            console.error("Screen share error:", e);
            webrtcUtils.addLogMessage('logMessages', 'Failed to start screen sharing', 'error');
        }
    }

    stopScreenShare() {
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(t => t.stop());
            this.screenStream = null;
        }
        document.getElementById('mainVideo').srcObject = null;
        document.getElementById('waitingMessage').style.display = 'flex';
        this.isSharing = false;
        
        // Notify all students
        if (this.socket && this.roomId) {
            this.socket.emit('screen-stopped', this.roomId);
            // Send content tracking stop event
            this.socket.emit('screen-share-stop');
        }

        // Update UI state
        app.isSharing = false;
        const btn = document.getElementById('shareBtn');
        if (btn) {
            btn.classList.remove('active');
            btn.innerHTML = '<span class="icon">📺</span> Share Screen';
        }
        
        webrtcUtils.addLogMessage('logMessages', 'Screen sharing stopped', 'info');
    }

    async connectToStudent(studentId) {
        const connectionStartTime = Date.now();
        const pc = webrtcUtils.createPeerConnection(); // Use WebRTC configuration
        this.peerConnections.set(studentId, pc);

        if (this.screenStream) {
            this.screenStream.getTracks().forEach(t => pc.addTrack(t, this.screenStream));
        }
        
        // Include mic if active
        if (this.micStream) {
            this.micStream.getTracks().forEach(t => pc.addTrack(t, this.micStream));
        }

        pc.onicecandidate = (e) => {
            if (e.candidate) this.socket.emit('ice-candidate', { target: studentId, candidate: e.candidate });
        };

        // Add performance monitoring when connection is established
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') {
                const connectionTime = Date.now() - connectionStartTime;
                
                // Log connection performance
                this.logConnectionPerformance(studentId, connectionTime);
                
                // Start performance monitoring
                this.startPerformanceMonitoring(studentId, pc);
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                // Log connection failure
                this.logConnectionFailure(studentId, pc.connectionState);
                
                // Stop performance monitoring
                this.stopPerformanceMonitoring(studentId);
            }
        };

        // Add connection timeout
        const connectionTimeout = setTimeout(() => {
            if (pc.connectionState === 'connecting' || pc.connectionState === 'new') {
                console.warn(`Connection timeout for student ${studentId}`);
                this.logConnectionFailure(studentId, 'timeout');
            }
        }, 15000); // 15 second timeout

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.socket.emit('offer', { target: studentId, roomId: this.roomId, offer });
        
        // Clear timeout when connection is established or fails
        pc.onconnectionstatechange = () => {
            if (pc.connectionState !== 'connecting' && pc.connectionState !== 'new') {
                clearTimeout(connectionTimeout);
            }
            
            if (pc.connectionState === 'connected') {
                const connectionTime = Date.now() - connectionStartTime;
                
                // Log connection performance
                this.logConnectionPerformance(studentId, connectionTime);
                
                // Start performance monitoring
                this.startPerformanceMonitoring(studentId, pc);
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                // Log connection failure
                this.logConnectionFailure(studentId, pc.connectionState);
                
                // Stop performance monitoring
                this.stopPerformanceMonitoring(studentId);
            }
        };
    }

    // Log connection performance metrics
    async logConnectionPerformance(studentId, connectionTime) {
        try {
            const systemInfo = webrtcUtils.getSystemInfo();
            const performanceData = {
                connection_time_ms: connectionTime,
                browser_info: systemInfo.userAgent,
                network_type: systemInfo.connection?.effectiveType || 'unknown',
                timestamp: Date.now()
            };

            // Log to database if session exists
            if (this.roomId) {
                const response = await fetch('/api/performance-log', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        roomId: this.roomId,
                        participantId: studentId,
                        logType: 'connection',
                        message: `Student connected in ${connectionTime}ms`,
                        metrics: performanceData
                    })
                });
            }

            console.log(`Connection Performance - Student ${studentId}: ${connectionTime}ms`);
        } catch (error) {
            console.error('Error logging connection performance:', error);
        }
    }

    // Log connection failure
    async logConnectionFailure(studentId, failureReason) {
        try {
            const systemInfo = webrtcUtils.getSystemInfo();
            const performanceData = {
                failure_reason: failureReason,
                browser_info: systemInfo.userAgent,
                network_type: systemInfo.connection?.effectiveType || 'unknown',
                timestamp: Date.now()
            };

            // Log to database if session exists
            if (this.roomId) {
                const response = await fetch('/api/performance-log', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        roomId: this.roomId,
                        participantId: studentId,
                        logType: 'error',
                        message: `Connection failed: ${failureReason}`,
                        metrics: performanceData
                    })
                });
            }

            console.warn(`Connection Failure - Student ${studentId}: ${failureReason}`);
        } catch (error) {
            console.error('Error logging connection failure:', error);
        }
    }

    // Start performance monitoring for a connection
    startPerformanceMonitoring(studentId, peerConnection) {
        const stopMonitoring = webrtcUtils.monitorPerformance(peerConnection, (performanceData) => {
            // Log performance data periodically
            this.logPerformanceMetrics(studentId, performanceData);
        });

        // Store stop function for cleanup
        this.performanceMonitors.set(studentId, stopMonitoring);
    }

    // Stop performance monitoring for a connection
    stopPerformanceMonitoring(studentId) {
        const stopMonitoring = this.performanceMonitors.get(studentId);
        if (stopMonitoring) {
            stopMonitoring();
            this.performanceMonitors.delete(studentId);
        }
    }

    // Log performance metrics to database
    async logPerformanceMetrics(studentId, performanceData) {
        try {
            if (this.roomId) {
                const response = await fetch('/api/performance-log', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        roomId: this.roomId,
                        participantId: studentId,
                        logType: 'performance',
                        message: `Performance: ${performanceData.bandwidth.toFixed(2)}kbps, ${performanceData.latency.toFixed(2)}ms latency`,
                        metrics: performanceData
                    })
                });
            }
        } catch (error) {
            console.error('Error logging performance metrics:', error);
        }
    }

    updateParticipantsUI(participants) {
        const list = document.getElementById('studentGrid');
        document.getElementById('studentCount').textContent = participants.length;
        list.innerHTML = participants.map(p => `
            <div class="participant-chip">
                <div class="avatar">${p.name.charAt(0).toUpperCase()}</div>
                <div class="p-name">${p.name}</div>
            </div>
        `).join('');
    }

    async exportAttendance() {
        if (!this.roomId) {
            alert('No active session found');
            return;
        }

        try {
            const response = await fetch(`/api/session/${this.roomId}/attendance/export`);
            if (response.ok) {
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `attendance_${this.roomId}_${new Date().toISOString().split('T')[0]}.csv`;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
                
                webrtcUtils.addLogMessage('logMessages', 'Attendance exported successfully', 'success');
            } else {
                const error = await response.json();
                alert('Failed to export attendance: ' + error.error);
            }
        } catch (error) {
            console.error('Error exporting attendance:', error);
            alert('Failed to export attendance. Please try again.');
        }
    }

    endSession() {
        if (!this.roomId) {
            alert('No active session to end');
            return;
        }

        if (confirm('Are you sure you want to end this session? All students will be disconnected.')) {
            // Disconnect from socket - this will trigger the server to end the session
            if (this.socket) {
                this.socket.disconnect();
            }
            
            // Clear local data
            this.roomId = null;
            this.isSharing = false;
            
            // Stop screen sharing if active
            if (this.screenStream) {
                this.screenStream.getTracks().forEach(track => track.stop());
                this.screenStream = null;
            }
            
            // Stop microphone if active
            if (this.micStream) {
                this.micStream.getTracks().forEach(track => track.stop());
                this.micStream = null;
            }
            
            // Clear peer connections
            this.peerConnections.clear();
            
            // Return to role selection
            location.reload();
        }
    }
}

const presenter = new Presenter();
function createRoom() { presenter.createRoom(); }
function exportAttendance() { presenter.exportAttendance(); }
function endSession() { presenter.endSession(); }
