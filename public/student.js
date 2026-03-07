// Professional Student Logic
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
    }

    initializeSocket() {
        this.socket = io();

        this.socket.on('connect', () => this.socketId = this.socket.id);

        this.socket.on('room-available', (room) => this.updateDiscoveryList(room));

        this.socket.on('room-joined', (data) => {
            this.roomId = data.roomId;
            app.updateSessionUI(this.roomId, 'Joined');
            this.displayPresenterDetails(data.presenterDetails);
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
            
            // If the presenter stopped sharing, clear the presenterStream
            if (data && data.senderId === this.presenterId) {
                this.presenterStream = null;
            }

            if (this.presenterStream) {
                video.srcObject = this.presenterStream;
                video.style.display = 'block';
                document.getElementById('waitingMessage').style.display = 'none';
            } else {
                video.srcObject = null;
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
        const info = {
            name: document.getElementById('studentName').value.trim(),
            email: document.getElementById('studentEmail').value.trim(),
        };
        const roomId = document.getElementById('joinRoomId').value.trim();

        if (!info.name || !info.email || !roomId) return alert("Missing Info!");
        if (!info.email.endsWith('@std.must.ac.ug')) return alert("Use MUST email!");

        this.socket.emit('join-room', { roomId, studentInfo: info });
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

            this.screenStream.getVideoTracks()[0].onended = () => this.stopScreenShare();

            // Add tracks to all existing peer connections (e.g., to the presenter)
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

            // Notify everyone else in the room (Students) to connect to us
            this.socket.emit('request-student-projection', { roomId: this.roomId });
        } catch (e) { console.error(e); }
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
        
        const pc = new RTCPeerConnection();
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
                document.getElementById('waitingMessage').style.display = 'none';
            }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.socket.emit('offer', { target: peerId, roomId: this.roomId, offer });
    }

    async handleOffer(data) {
        let pc = this.peerConnections.get(data.sender);
        if (!pc) {
            pc = new RTCPeerConnection();
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
                    document.getElementById('waitingMessage').style.display = 'none';
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
}

const student = new Student();
function joinRoom() { student.joinRoom(); }
function autoJoin(id) { 
    const joinRoomField = document.getElementById('joinRoomId');
    joinRoomField.value = id;
    joinRoomField.setAttribute('readonly', true);
    student.joinRoom(); 
}
