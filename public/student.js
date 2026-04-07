// Professional Student Logic

// Configuration
const FOCUS_DETECTION_ENABLED = true; // Set to false to disable focus detection

class Student {
    constructor() {
        this.socket = null;
        this.roomId = null;
        this.socketId = null;
        this.peerConnections = new Map(); // Store connections for each sender
        this.screenStream = null;
        this.micStream = null;
        this.presenterId = null;
        this.presenterStream = null;
        this.chatMessages = [];
        this.studentName = '';
        this.isActive = true;
        this.warningTimeout = null;
        this.logoutTimeout = null;
        this.performanceMonitors = new Map(); // Track performance monitors
        this.connectionStartTime = null;
    }

    initializeSocket() {
        // Connect to different servers based on environment
        const isProduction = window.location.hostname !== 'localhost';
        const serverUrl = isProduction 
            ? `http://${window.location.hostname}:3001` // Use current hostname with port 3001
            : 'http://localhost:3001'; // Updated to port 3001
        
        console.log('Student connecting to:', serverUrl);
        console.log('Is production:', isProduction);
        console.log('Current hostname:', window.location.hostname);
        
        this.socket = io(serverUrl);

        this.socket.on('connect', () => {
            console.log('Student socket connected:', this.socket.id);
            this.socketId = this.socket.id;
        });

        this.socket.on('disconnect', () => {
            console.log('Student socket disconnected');
        });

        this.socket.on('connect_error', (error) => {
            console.error('Student socket connection error:', error);
        });

        this.socket.on('room-available', (room) => this.updateDiscoveryList(room));

        this.socket.on('room-joined', (data) => {
            this.roomId = data.roomId;
            this.studentName = data.studentName;
            app.updateSessionUI(this.roomId, 'Joined');
            this.displayPresenterDetails(data.presenterDetails);
            
            // Show chat notification icon for students
            document.getElementById('chatNotificationIcon').style.display = 'flex';
            
            // Ensure waiting message is visible when joining room
            document.getElementById('waitingMessage').style.display = 'flex';
            
            // Show focus policy notification and start focus detection
            if (FOCUS_DETECTION_ENABLED) {
                this.showFocusPolicyNotification();
                
                // Start focus detection after joining room
                setTimeout(() => {
                    this.initializeFocusDetection();
                }, 2000); // Start after 2 seconds to allow student to read the policy
            }
        });

        this.socket.on('session-ended', (data) => {
            // Handle session ended by presenter
            this.showSessionEndedNotification(data.message || 'Session has been ended by the presenter');
            setTimeout(() => {
                location.reload();
            }, 3000);
        });

        this.socket.on('chat-message', (data) => {
            this.addChatMessage(data);
            // Show notification for new messages
            if (typeof showChatNotification === 'function') {
                showChatNotification();
            }
        });

        this.socket.on('room-joined', (data) => {
            webrtcUtils.addLogMessage('logMessages', `Successfully joined room: ${this.roomId}`, 'success');
        });

        this.socket.on('presenter-info', (data) => {
            this.presenterId = data.presenterId;
        });

        this.socket.on('student-projection-requested', (data) => {
            if (!this.peerConnections.has(data.studentId)) {
                this.connectToPeer(data.studentId);
            }
        });

        this.socket.on('student-screen-share-started', (data) => {
            console.log('Student started screen sharing:', data);
        });

        this.socket.on('offer', async (data) => this.handleOffer(data));

        this.socket.on('answer', async (data) => {
            const pc = this.peerConnections.get(data.sender);
            if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        });

        this.socket.on('ice-candidate', async (data) => {
            const pc = this.peerConnections.get(data.sender);
            if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        });

        this.socket.on('participants-updated', (list) => this.updateParticipantsUI(list));

        this.socket.on('screen-stopped', (data) => {
            const video = document.getElementById('mainVideo');
            
            // Only hide waiting message if we have a presenter stream
            if (this.presenterStream) {
                video.srcObject = this.presenterStream;
                video.style.display = 'block';
                document.getElementById('waitingMessage').style.display = 'none';
            } else {
                video.srcObject = null;
                // Show waiting message when no presenter stream is available
                document.getElementById('waitingMessage').style.display = 'flex';
                // User requested a "refresh" feel when presenter stops
                if (data && data.senderId === this.presenterId) {
                    webrtcUtils.addLogMessage('logMessages', 'Presenter stopped sharing.', 'info');
                }
            }
        });

        this.socket.on('presenter-disconnected', () => {
            alert('Session ended.');
            location.reload();
        });
    }

    joinRoom() {
        console.log('Student joinRoom called');
        console.log('Socket connected:', this.socket?.connected);
        console.log('Socket ID:', this.socket?.id);
        
        const details = {
            name: document.getElementById('studentName').value.trim(),
            email: document.getElementById('studentEmail').value.trim(),
            roomId: document.getElementById('joinRoomId').value.trim()
        };

        console.log('Join details:', details);

        if (!details.name || !details.roomId) return alert("Missing Info!");

        if (!this.socket || !this.socket.connected) {
            console.error('Socket not connected - cannot join room');
            alert('Connection error. Please refresh the page and try again.');
            return;
        }

        console.log('Emitting join-room event');
        this.socket.emit('join-room', details);
    }

    async toggleMic(enabled) {
        if (enabled) {
            try {
                this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                this.peerConnections.forEach(pc => {
                    const track = this.micStream.getAudioTracks()[0];
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
            this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
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

            this.screenStream.getVideoTracks()[0].onended = () => this.stopScreenShare();

            // Add tracks to all existing peer connections (presenter + other students)
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

            // Notify everyone in the room to connect to this student
            this.socket.emit('student-screen-share-started', { roomId: this.roomId });
            
        } catch (e) { 
            console.error("Screen share error:", e);
            alert('Failed to start screen sharing');
        }
    }

    stopScreenShare() {
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(t => t.stop());
            this.screenStream = null;
        }
        
        const video = document.getElementById('mainVideo');
        if (this.presenterStream) {
            video.srcObject = this.presenterStream;
            video.style.display = 'block';
            document.getElementById('waitingMessage').style.display = 'none';
        } else {
            video.srcObject = null;
            document.getElementById('waitingMessage').style.display = 'flex';
        }
        
        // Notify others in room
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
    }

    async connectToPeer(peerId) {
        if (this.peerConnections.has(peerId)) return;
        
        const connectionStartTime = Date.now();
        const pc = webrtcUtils.createPeerConnection(); // Use optimized WebRTC configuration
        this.peerConnections.set(peerId, pc);

        if (this.screenStream) {
            this.screenStream.getTracks().forEach(t => pc.addTrack(t, this.screenStream));
        }
        if (this.micStream) {
            this.micStream.getTracks().forEach(t => pc.addTrack(t, this.micStream));
        }

        pc.onicecandidate = (e) => {
            if (e.candidate) this.socket.emit('ice-candidate', { target: peerId, candidate: e.candidate });
        };

        pc.ontrack = (e) => {
            if (peerId === this.presenterId) {
                this.presenterStream = e.streams[0];
            }
            const video = document.getElementById('mainVideo');
            if (video.srcObject !== e.streams[0]) {
                video.srcObject = e.streams[0];
                video.style.display = 'block';
                // Only hide waiting message if this is the presenter's stream
                if (peerId === this.presenterId) {
                    document.getElementById('waitingMessage').style.display = 'none';
                }
            }
        };

        // Add performance monitoring when connection is established
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') {
                const connectionTime = Date.now() - connectionStartTime;
                
                // Log connection performance
                this.logConnectionPerformance(peerId, connectionTime);
                
                // Start performance monitoring
                this.startPerformanceMonitoring(peerId, pc);
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                // Log connection failure
                this.logConnectionFailure(peerId, pc.connectionState);
                
                // Stop performance monitoring
                this.stopPerformanceMonitoring(peerId);
            }
        };

        // Add connection timeout
        const connectionTimeout = setTimeout(() => {
            if (pc.connectionState === 'connecting' || pc.connectionState === 'new') {
                console.warn(`Connection timeout for peer ${peerId}`);
                this.logConnectionFailure(peerId, 'timeout');
            }
        }, 15000); // 15 second timeout

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.socket.emit('offer', { target: peerId, roomId: this.roomId, offer });
        
        // Clear timeout when connection is established or fails
        pc.onconnectionstatechange = () => {
            if (pc.connectionState !== 'connecting' && pc.connectionState !== 'new') {
                clearTimeout(connectionTimeout);
            }
            
            if (pc.connectionState === 'connected') {
                const connectionTime = Date.now() - connectionStartTime;
                
                // Log connection performance
                this.logConnectionPerformance(peerId, connectionTime);
                
                // Start performance monitoring
                this.startPerformanceMonitoring(peerId, pc);
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                // Log connection failure
                this.logConnectionFailure(peerId, pc.connectionState);
                
                // Stop performance monitoring
                this.stopPerformanceMonitoring(peerId);
            }
        };
    }

    // Log connection performance metrics
    async logConnectionPerformance(peerId, connectionTime) {
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
                        participantId: this.socketId,
                        logType: 'connection',
                        message: `Connected to ${peerId} in ${connectionTime}ms`,
                        metrics: performanceData
                    })
                });
            }

            console.log(`Connection Performance - Peer ${peerId}: ${connectionTime}ms`);
        } catch (error) {
            console.error('Error logging connection performance:', error);
        }
    }

    // Log connection failure
    async logConnectionFailure(peerId, failureReason) {
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
                        participantId: this.socketId,
                        logType: 'error',
                        message: `Connection to ${peerId} failed: ${failureReason}`,
                        metrics: performanceData
                    })
                });
            }

            console.warn(`Connection Failure - Peer ${peerId}: ${failureReason}`);
        } catch (error) {
            console.error('Error logging connection failure:', error);
        }
    }

    // Start performance monitoring for a connection
    startPerformanceMonitoring(peerId, peerConnection) {
        const stopMonitoring = webrtcUtils.monitorPerformance(peerConnection, (performanceData) => {
            // Log performance data periodically
            this.logPerformanceMetrics(peerId, performanceData);
        });

        // Store stop function for cleanup
        this.performanceMonitors.set(peerId, stopMonitoring);
    }

    // Stop performance monitoring for a connection
    stopPerformanceMonitoring(peerId) {
        const stopMonitoring = this.performanceMonitors.get(peerId);
        if (stopMonitoring) {
            stopMonitoring();
            this.performanceMonitors.delete(peerId);
        }
    }

    // Log performance metrics to database
    async logPerformanceMetrics(peerId, performanceData) {
        try {
            if (this.roomId) {
                const response = await fetch('/api/performance-log', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        roomId: this.roomId,
                        participantId: this.socketId,
                        logType: 'performance',
                        message: `Performance with ${peerId}: ${performanceData.bandwidth.toFixed(2)}kbps, ${performanceData.latency.toFixed(2)}ms latency`,
                        metrics: performanceData
                    })
                });
            }
        } catch (error) {
            console.error('Error logging performance metrics:', error);
        }
    }

    async handleOffer(data) {
        let pc = this.peerConnections.get(data.sender);
        if (!pc) {
            pc = webrtcUtils.createPeerConnection(); // Use WebRTC configuration
            this.peerConnections.set(data.sender, pc);
            
            pc.onicecandidate = (e) => {
                if (e.candidate) this.socket.emit('ice-candidate', { target: data.sender, candidate: e.candidate });
            };

            pc.ontrack = (e) => {
                if (data.sender === this.presenterId) {
                    this.presenterStream = e.streams[0];
                }
                const video = document.getElementById('mainVideo');
                if (video.srcObject !== e.streams[0]) {
                    video.srcObject = e.streams[0];
                    video.style.display = 'block';
                    // Only hide waiting message if this is the presenter's stream
                    if (data.sender === this.presenterId) {
                        document.getElementById('waitingMessage').style.display = 'none';
                    }
                    video.muted = false;
                }
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
    }

    updateDiscoveryList(room) {
        const list = document.getElementById('availableRooms');
        const existing = document.getElementById(`room-${room.roomId}`);
        if (!existing) {
            // FILTER: If student has a link, only show that room
            const urlParams = new URLSearchParams(window.location.search);
            const urlRoomId = urlParams.get('room');
            if (urlRoomId && room.roomId !== urlRoomId) return;

            const div = document.createElement('div');
            div.id = `room-${room.roomId}`;
            div.className = 'room-card-tiny';
            div.innerHTML = `<span>${room.details.topic}</span> <button class="btn btn-primary" onclick="autoJoin('${room.roomId}')">Join</button>`;
            list.appendChild(div);
        }
    }

    displayPresenterDetails(details) {
        const overlay = document.getElementById('presenterInfoOverlay');
        overlay.innerHTML = `<strong>Lecture:</strong> ${details.topic} <span style="opacity:0.6; margin:0 8px;">•</span> <strong>Presenter:</strong> ${details.name}`;
        overlay.style.display = 'block';
    }

    updateParticipantsUI(participants) {
        const list = document.getElementById('studentGrid');
        document.getElementById('studentCount').textContent = participants.length;
        list.innerHTML = participants.map(p => `
            <div class="participant-chip ${p.socketId === this.socketId ? 'highlight-me' : ''}">
                <div class="avatar">${p.name.charAt(0).toUpperCase()}</div>
                <div class="p-name">${p.name} ${p.socketId === this.socketId ? '(You)' : ''}</div>
            </div>
        `).join('');
    }

    // Chat methods
    sendChatMessage(message) {
        if (!message.trim() || !this.roomId) {
            console.log('Student sendChatMessage blocked:', { message: message.trim(), roomId: this.roomId, studentName: this.studentName });
            return;
        }
        
        const chatData = {
            roomId: this.roomId,
            senderName: this.studentName || 'Student',
            message: message.trim(),
            role: 'student',
            timestamp: new Date().toISOString()
        };
        
        console.log('Student sending chat data:', chatData);
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

    leaveSession() {
        if (this.socket) {
            this.socket.disconnect();
        }
        // Clear all session data
        this.roomId = null;
        this.studentName = null;
        this.isActive = false;
        this.cleanup();
        
        // Return to role selection
        location.reload();
    }

    showSessionEndedNotification(message) {
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: #dc3545;
            color: white;
            padding: 2rem;
            border-radius: 12px;
            z-index: 10000;
            font-family: system-ui, -apple-system, sans-serif;
            text-align: center;
            box-shadow: 0 10px 25px rgba(0,0,0,0.3);
            max-width: 400px;
        `;
        notification.innerHTML = `
            <h2 style="color: white; margin-bottom: 20px; font-size: 1.5rem;">🔴 Session Ended</h2>
            <p style="font-size: 1.1rem; text-align: center; margin-bottom: 20px;">
                ${message}
            </p>
            <p style="font-size: 0.9rem; opacity: 0.8;">
                You will be redirected to the main screen...
            </p>
        `;
        
        document.body.appendChild(notification);
        
        // Auto-remove after 3 seconds
        setTimeout(() => {
            const notif = document.getElementById('sessionEndedNotification');
            if (notif) notif.remove();
        }, 3000);
    }

    // Focus Detection Methods
    showFocusPolicyNotification() {
        const notification = document.createElement('div');
        notification.id = 'focusPolicyNotification';
        notification.innerHTML = `
            <div style="
                position: fixed;
                top: 20px;
                right: 20px;
                background: #333399;
                color: white;
                padding: 16px 20px;
                border-radius: 12px;
                border-left: 4px solid #FCB900;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                z-index: 9999;
                max-width: 350px;
                font-family: system-ui, -apple-system, sans-serif;
            ">
                <div style="display: flex; align-items: center; margin-bottom: 8px;">
                    <span style="font-size: 1.2rem; margin-right: 8px;">📚</span>
                    <strong style="color: #FCB900;">Focus Policy Active</strong>
                </div>
                <p style="margin: 0; font-size: 0.9rem; line-height: 1.4;">
                    For the best learning experience, please stay focused on this lecture. Switching to other apps will automatically disconnect you from the session.
                </p>
                <button onclick="this.parentElement.parentElement.remove()" style="
                    background: #FCB900;
                    color: #333399;
                    border: none;
                    padding: 6px 12px;
                    font-size: 0.8rem;
                    font-weight: 600;
                    border-radius: 6px;
                    cursor: pointer;
                    margin-top: 12px;
                ">
                    I Understand
                </button>
            </div>
        `;
        
        document.body.appendChild(notification);

        
        // Auto-remove after 10 seconds
        setTimeout(() => {
            const notif = document.getElementById('focusPolicyNotification');
            if (notif) notif.remove();
        }, 10000);
    }

    initializeFocusDetection() {
        // Page Visibility API
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.handlePageHidden();
            } else {
                this.handlePageVisible();
            }
        });

        // Window focus/blur events
        window.addEventListener('blur', () => {
            this.handleWindowBlur();
        });

        window.addEventListener('focus', () => {
            this.handleWindowFocus();
        });

        // Before unload event
        window.addEventListener('beforeunload', () => {
            this.cleanup();
        });
    }

    handlePageHidden() {
        if (!this.isActive || !this.roomId) return;
        
        console.log('Student page hidden - starting logout process');
        this.showWarning();
        
        // Clear any existing timeouts
        if (this.warningTimeout) clearTimeout(this.warningTimeout);
        if (this.logoutTimeout) clearTimeout(this.logoutTimeout);
        
        // Show warning for 3 seconds, then logout
        this.warningTimeout = setTimeout(() => {
            this.forceLogout();
        }, 5000);
    }

    handlePageVisible() {
        if (!this.isActive || !this.roomId) return;
        
        console.log('Student page visible - cancelling logout');
        this.hideWarning();
        
        // Clear timeouts if student returns within warning period
        if (this.warningTimeout) {
            clearTimeout(this.warningTimeout);
            this.warningTimeout = null;
        }
        if (this.logoutTimeout) {
            clearTimeout(this.logoutTimeout);
            this.logoutTimeout = null;
        }
    }

    handleWindowBlur() {
        // Additional check for window losing focus
        setTimeout(() => {
            if (document.hidden && this.isActive && this.roomId) {
                this.handlePageHidden();
            }
        }, 100);
    }

    handleWindowFocus() {
        if (this.isActive && this.roomId) {
            this.handlePageVisible();
        }
    }

    showWarning() {
        // Create warning overlay
        const warning = document.createElement('div');
        warning.id = 'focusWarning';
        warning.innerHTML = `
            <div style="
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.9);
                color: white;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                z-index: 10000;
                font-family: system-ui, -apple-system, sans-serif;
            ">
                <h2 style="color: #FCB900; margin-bottom: 20px;">⚠️ Attention Required!</h2>
                <p style="font-size: 1.2rem; text-align: center; max-width: 400px; margin-bottom: 20px;">
                    Please stay focused on the lecture. Switching to other apps will disconnect you from the session.
                </p>
                <p style="font-size: 1rem; opacity: 0.8;">
                    Return to this window immediately to continue...
                </p>
                <div style="margin-top: 30px;">
                    <div style="width: 60px; height: 60px; border: 4px solid #FCB900; border-top: 4px solid transparent; border-radius: 50%; animation: spin 1s linear infinite;"></div>
                </div>
            </div>
        `;
        
        // Add spinning animation
        const style = document.createElement('style');
        style.textContent = `
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
        
        document.body.appendChild(warning);
    }

    hideWarning() {
        const warning = document.getElementById('focusWarning');
        if (warning) {
            warning.remove();
        }
    }

    forceLogout() {
        console.log('Force logging out student due to inactivity');
        this.hideWarning();
        this.cleanup();
        
        // Show logout message
        const logoutMessage = document.createElement('div');
        logoutMessage.innerHTML = `
            <div style="
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: #333399;
                color: white;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                z-index: 10000;
                font-family: system-ui, -apple-system, sans-serif;
            ">
                <h2 style="color: #FCB900; margin-bottom: 20px;">Session Ended</h2>
                <p style="font-size: 1.2rem; text-align: center; max-width: 400px; margin-bottom: 30px;">
                    You were disconnected for switching to other applications. Please stay focused during lectures.
                </p>
                <button onclick="location.reload()" style="
                    background: #FCB900;
                    color: #333399;
                    border: none;
                    padding: 12px 24px;
                    font-size: 1rem;
                    font-weight: 600;
                    border-radius: 8px;
                    cursor: pointer;
                ">
                    Rejoin Session
                </button>
            </div>
        `;
        
        document.body.innerHTML = '';
        document.body.appendChild(logoutMessage);
        
        // Disconnect from server
        if (this.socket) {
            this.socket.disconnect();
        }
    }

    cleanup() {
        this.isActive = false;
        if (this.warningTimeout) {
            clearTimeout(this.warningTimeout);
            this.warningTimeout = null;
        }
        if (this.logoutTimeout) {
            clearTimeout(this.logoutTimeout);
            this.logoutTimeout = null;
        }
        this.hideWarning();
    }
}

const student = new Student();
function joinRoom() { student.joinRoom(); }
function autoJoin(id) { 
    const joinRoomField = document.getElementById('joinRoomId');
    joinRoomField.value = id;
    joinRoomField.setAttribute('readonly', true);
    student.joinRoom(); 
}
