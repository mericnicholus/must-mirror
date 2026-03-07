// Main application controller
class ScreenMirroringApp {
    constructor() {
        this.currentRole = null;
        this.isMuted = true;
        this.isSharing = false;
        this.checkUrlParams();
    }

    checkUrlParams() {
        const urlParams = new URLSearchParams(window.location.search);
        const roomId = urlParams.get('room');
        if (roomId) {
            setTimeout(() => {
                this.selectRole('student');
                const joinRoomField = document.getElementById('joinRoomId');
                joinRoomField.value = roomId;
                joinRoomField.setAttribute('readonly', true);
                
                // Hide discovery section if joining via link
                const discovery = document.getElementById('discoverySection');
                if (discovery) discovery.style.display = 'none';
            }, 800);
        }
    }

    selectRole(role) {
        this.currentRole = role;
        document.getElementById('roleSelector').style.display = 'none';
        document.getElementById('mainApp').style.display = 'grid'; // Changed from block to grid

        if (role === 'presenter') {
            document.getElementById('presenterSetup').style.display = 'flex';
            presenter.initializeSocket();
        } else {
            document.getElementById('studentSetup').style.display = 'flex';
            student.initializeSocket();
        }
    }

    updateSessionUI(roomId, status) {
        document.getElementById('activeSessionInfo').style.display = 'flex';
        document.getElementById('displayRoomId').textContent = `Room: ${roomId}`;
        document.getElementById('connectionStatusText').textContent = status;
        
        // Show action bar
        const actionBar = document.querySelector('.action-bar');
        if (actionBar) actionBar.style.display = 'flex';
        
        // Hide setup overlays
        document.getElementById('presenterSetup').style.display = 'none';
        document.getElementById('studentSetup').style.display = 'none';
        
        if (this.currentRole === 'presenter') {
            document.getElementById('shareLinkContainer').style.display = 'block';
            document.getElementById('shareLinkInput').value = `${window.location.origin}/?room=${roomId}`;
        }
    }
}

const app = new ScreenMirroringApp();

function selectRole(role) { app.selectRole(role); }

// GLOBAL BRIDGES
function toggleMute() {
    const btn = document.getElementById('muteBtn');
    app.isMuted = !app.isMuted;
    
    if (app.currentRole === 'presenter') {
        presenter.toggleMic(!app.isMuted);
    } else {
        student.toggleMic(!app.isMuted);
    }

    btn.classList.toggle('active', app.isMuted);
    btn.innerHTML = app.isMuted ? '<span class="icon">🔇</span> Unmute' : '<span class="icon">🎤</span> Mute';
}

async function toggleShare() {
    const btn = document.getElementById('shareBtn');
    
    if (app.currentRole === 'presenter') {
        if (!app.isSharing) {
            await presenter.startScreenShare();
            app.isSharing = true;
        } else {
            presenter.stopScreenShare();
            app.isSharing = false;
        }
    } else {
        if (!app.isSharing) {
            await student.startScreenShare();
            app.isSharing = true;
        } else {
            student.stopScreenShare();
            app.isSharing = false;
        }
    }

    btn.classList.toggle('active', app.isSharing);
    btn.innerHTML = app.isSharing ? '<span class="icon">⏹</span> Stop Sharing' : '<span class="icon">📺</span> Share Screen';
}

function toggleFullscreen() {
    const container = document.querySelector('.video-container');
    if (!document.fullscreenElement) {
        container.requestFullscreen().catch(err => console.log(err));
    } else {
        document.exitFullscreen();
    }
}
