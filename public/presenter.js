// Professional Presenter Logic

class Presenter {
    constructor() {
        this.socket = null;
        this.roomId = null;
        this.screenStream = null;
        this.micStream = null;
        this.peerConnections = new Map();
        this.isSharing = false;
    }

    initializeSocket() {
        // Connect to different servers based on environment
        const isProduction = window.location.hostname !== 'localhost';
        const serverUrl = isProduction 
            ? 'https://must-mirror.onrender.com' // Replace with your actual Render URL
            : 'http://localhost:3000';
        
        this.socket = io(serverUrl);
        
        this.socket.on('room-created', (data) => {
            this.roomId = data.roomId;
            app.updateSessionUI(this.roomId, 'Active');
            webrtcUtils.addLogMessage('logMessages', `Lecture Room Active: ${this.roomId}`, 'success');
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
                pc = new RTCPeerConnection();
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
            this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            const video = document.getElementById('mainVideo');
            video.srcObject = this.screenStream;
            video.style.display = 'block';
            document.getElementById('waitingMessage').style.display = 'none';

            this.screenStream.getVideoTracks()[0].onended = () => this.stopScreenShare();

            // Push tracks to all existing students and renegotiate
            this.peerConnections.forEach(async (pc, studentId) => {
                this.screenStream.getTracks().forEach(track => pc.addTrack(track, this.screenStream));
                
                // Renegotiate
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                this.socket.emit('offer', { target: studentId, roomId: this.roomId, offer });
            });
            this.isSharing = true;
        } catch (e) { console.error(e); }
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
        }

        // Update UI state
        app.isSharing = false;
        const btn = document.getElementById('shareBtn');
        if (btn) {
            btn.classList.remove('active');
            btn.innerHTML = '<span class="icon">📺</span> Share Screen';
        }
    }

    async connectToStudent(studentId) {
        const pc = new RTCPeerConnection();
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

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.socket.emit('offer', { target: studentId, roomId: this.roomId, offer });
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
}

const presenter = new Presenter();
function createRoom() { presenter.createRoom(); }
