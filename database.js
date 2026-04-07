const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Database file path
const DB_PATH = path.join(__dirname, 'wireless_screen_sharing.db');

class Database {
    constructor() {
        this.db = null;
    }

    // Initialize database connection and create tables
    async initialize() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(DB_PATH, (err) => {
                if (err) {
                    console.error('Error opening database:', err);
                    reject(err);
                } else {
                    console.log('Connected to SQLite database.');
                    this.createTables().then(resolve).catch(reject);
                }
            });
        });
    }

    async createTables() {
        try {
            // Create tables with IF NOT EXISTS to avoid conflicts
            await this.run(`
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    email TEXT UNIQUE,
                    role TEXT NOT NULL CHECK (role IN ('presenter', 'student')),
                    socket_id TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_active DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            await this.run(`
                CREATE TABLE IF NOT EXISTS sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    room_id TEXT UNIQUE NOT NULL,
                    presenter_id INTEGER NOT NULL,
                    presenter_name TEXT NOT NULL,
                    title TEXT,
                    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'ended')),
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    ended_at DATETIME,
                    participant_count INTEGER DEFAULT 0,
                    FOREIGN KEY (presenter_id) REFERENCES users (id)
                )
            `);

            // Create content_shares table with basic structure first
            await this.run(`
                CREATE TABLE IF NOT EXISTS content_shares (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    share_type TEXT NOT NULL CHECK (share_type IN ('screen', 'audio', 'video')),
                    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    ended_at DATETIME,
                    duration_seconds INTEGER,
                    FOREIGN KEY (session_id) REFERENCES sessions (id),
                    FOREIGN KEY (user_id) REFERENCES users (id)
                )
            `);

            // Check if we need to add new columns to content_shares table
            await this.migrateContentSharesTable();
            
            // Check if we need to migrate performance_logs table
            await this.migratePerformanceLogsTable();

            await this.run(`
                CREATE TABLE IF NOT EXISTS attendance (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    left_at DATETIME,
                    duration_seconds INTEGER,
                    FOREIGN KEY (session_id) REFERENCES sessions (id),
                    FOREIGN KEY (user_id) REFERENCES users (id)
                )
            `);

            // Performance logs table - network performance metrics
            await this.run(`
                CREATE TABLE IF NOT EXISTS performance_logs (
                    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id INTEGER NOT NULL,
                    participant_id INTEGER DEFAULT NULL,
                    latency_ms FLOAT DEFAULT NULL, -- Target: below 300 ms average
                    throughput_mbps FLOAT DEFAULT NULL, -- Target: 2–4 Mbps under H.264
                    packet_loss_pct FLOAT DEFAULT NULL, -- Target: below 5%
                    jitter_ms FLOAT DEFAULT NULL, -- Should be minimal to avoid stuttering
                    log_type TEXT NOT NULL CHECK (log_type IN ('connection', 'disconnection', 'error', 'warning', 'info', 'performance', 'content_share', 'screen_share', 'chat', 'attendance')),
                    message TEXT NOT NULL,
                    details TEXT, -- JSON string for additional performance data
                    recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (session_id) REFERENCES sessions (id),
                    FOREIGN KEY (participant_id) REFERENCES users (id)
                )
            `);

            // User feedback table - simplified with message
            await this.run(`
                CREATE TABLE IF NOT EXISTS user_feedback (
                    feedback_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
                    message TEXT,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users (id)
                )
            `);

            console.log('All database tables created successfully.');
        } catch (error) {
            console.error('Error creating tables:', error);
            throw error;
        }
    }

    async migrateContentSharesTable() {
        try {
            // Check if content_title column exists
            const tableInfo = await this.all("PRAGMA table_info(content_shares)");
            const hasContentTitle = tableInfo.some(column => column.name === 'content_title');
            
            if (!hasContentTitle) {
                console.log('Migrating content_shares table with new columns...');
                
                // Add new columns one by one
                await this.run('ALTER TABLE content_shares ADD COLUMN content_title TEXT');
                await this.run('ALTER TABLE content_shares ADD COLUMN content_description TEXT');
                await this.run('ALTER TABLE content_shares ADD COLUMN content_metadata TEXT');
                await this.run('ALTER TABLE content_shares ADD COLUMN slide_count INTEGER');
                await this.run('ALTER TABLE content_shares ADD COLUMN current_slide INTEGER DEFAULT 1');
                await this.run('ALTER TABLE content_shares ADD COLUMN is_active BOOLEAN DEFAULT 1');
                
                console.log('Content shares table migration completed.');
            }
        } catch (error) {
            console.error('Error migrating content_shares table:', error);
            // Don't throw error here, as the table might already have the columns
        }
    }

    async migratePerformanceLogsTable() {
        try {
            // Check if table has the old structure (id column instead of log_id)
            const tableInfo = await this.all("PRAGMA table_info(performance_logs)");
            const hasLogId = tableInfo.some(column => column.name === 'log_id');
            const hasParticipantId = tableInfo.some(column => column.name === 'participant_id');
            
            if (!hasLogId || !hasParticipantId) {
                console.log('Migrating performance_logs table to new schema...');
                
                // Get existing data
                const existingData = await this.all('SELECT * FROM performance_logs');
                
                // Drop old table
                await this.run('DROP TABLE IF EXISTS performance_logs');
                
                // Create new table with correct structure
                await this.run(`
                    CREATE TABLE performance_logs (
                        log_id INTEGER PRIMARY KEY AUTOINCREMENT,
                        session_id INTEGER NOT NULL,
                        participant_id INTEGER DEFAULT NULL,
                        latency_ms FLOAT DEFAULT NULL,
                        throughput_mbps FLOAT DEFAULT NULL,
                        packet_loss_pct FLOAT DEFAULT NULL,
                        jitter_ms FLOAT DEFAULT NULL,
                        log_type TEXT NOT NULL CHECK (log_type IN ('connection', 'disconnection', 'error', 'warning', 'info', 'performance', 'content_share', 'screen_share', 'chat', 'attendance')),
                        message TEXT NOT NULL,
                        details TEXT,
                        recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (session_id) REFERENCES sessions (id),
                        FOREIGN KEY (participant_id) REFERENCES users (id)
                    )
                `);
                
                // Migrate data from old table if it exists
                if (existingData.length > 0) {
                    existingData.forEach(row => {
                        // Map old columns to new ones
                        const sessionId = row.session_id;
                        const participantId = row.user_id || null; // Map user_id to participant_id
                        const logType = row.log_type;
                        const message = row.message;
                        const details = row.details;
                        const recordedAt = row.created_at || new Date().toISOString();
                        
                        this.run(`
                            INSERT INTO performance_logs (
                                session_id, participant_id, log_type, message, details, recorded_at
                            ) VALUES (?, ?, ?, ?, ?, ?)
                        `, [sessionId, participantId, logType, message, details, recordedAt]);
                    });
                }
                
                console.log('Performance logs table migration completed.');
            }
        } catch (error) {
            console.error('Error migrating performance_logs table:', error);
            // Don't throw error here, as the table might already have the correct structure
        }
    }

    // Helper method to run SQL queries
    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) {
                    console.error('SQL error:', err.message);
                    reject(err);
                } else {
                    resolve({ id: this.lastID, changes: this.changes });
                }
            });
        });
    }

    // Helper method to get single row
    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    console.error('SQL error:', err.message);
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    // Helper method to get multiple rows
    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    console.error('SQL error:', err.message);
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    // User management methods
    async createUser(name, email, role, socketId = null) {
        try {
            // Provide default email if not provided
            const userEmail = email || `${name.toLowerCase().replace(/\s+/g, '.')}@local.user`;
            
            const result = await this.run(
                'INSERT OR REPLACE INTO users (name, email, role, socket_id, last_active) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
                [name, userEmail, role, socketId]
            );
            return result.id;
        } catch (error) {
            console.error('Error creating user:', error);
            throw error;
        }
    }

    async updateUserSocket(userId, socketId) {
        await this.run(
            'UPDATE users SET socket_id = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?',
            [socketId, userId]
        );
    }

    async getUserByEmail(email) {
        return await this.get('SELECT * FROM users WHERE email = ?', [email]);
    }

    async getUserBySocketId(socketId) {
        return await this.get('SELECT * FROM users WHERE socket_id = ?', [socketId]);
    }

    // Session management methods
    async createSession(roomId, presenterId, presenterName, title = null) {
        try {
            const result = await this.run(
                'INSERT OR REPLACE INTO sessions (room_id, presenter_id, presenter_name, title, status, created_at) VALUES (?, ?, ?, ?, "active", CURRENT_TIMESTAMP)',
                [roomId, presenterId, presenterName, title]
            );
            return result.id;
        } catch (error) {
            console.error('Error creating session:', error);
            throw error;
        }
    }

    async getSessionByDbId(sessionId) {
        return await this.get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    }

    async endSession(roomId) {
        await this.run(
            'UPDATE sessions SET status = "ended", ended_at = CURRENT_TIMESTAMP WHERE room_id = ?',
            [roomId]
        );
    }

    async getSession(roomId) {
        return await this.get('SELECT * FROM sessions WHERE room_id = ?', [roomId]);
    }

    async updateParticipantCount(roomId, count) {
        await this.run(
            'UPDATE sessions SET participant_count = ? WHERE room_id = ?',
            [count, roomId]
        );
    }

    // Content sharing methods
    async startContentShare(sessionId, userId, shareType) {
        const result = await this.run(
            'INSERT INTO content_shares (session_id, user_id, share_type) VALUES (?, ?, ?)',
            [sessionId, userId, shareType]
        );
        return result.id;
    }

    async endContentShare(shareId) {
        const share = await this.get('SELECT started_at FROM content_shares WHERE id = ?', [shareId]);
        if (share) {
            const duration = Math.floor((Date.now() - new Date(share.started_at).getTime()) / 1000);
            await this.run(
                'UPDATE content_shares SET ended_at = CURRENT_TIMESTAMP, duration_seconds = ? WHERE id = ?',
                [duration, shareId]
            );
        }
    }

    // Simplified user feedback methods
    async submitFeedback(userId, rating, message = null) {
        try {
            const result = await this.run(
                'INSERT INTO user_feedback (user_id, rating, message) VALUES (?, ?, ?)',
                [userId, rating, message]
            );
            return result.lastID;
        } catch (error) {
            console.error('Error submitting feedback:', error);
            throw error;
        }
    }

    async getFeedback(limit = 100) {
        try {
            const feedback = await this.all(`
                SELECT 
                    uf.*,
                    u.name as user_name,
                    u.email as user_email,
                    u.role as user_role
                FROM user_feedback uf
                LEFT JOIN users u ON uf.user_id = u.id
                ORDER BY uf.created_at DESC
                LIMIT ?
            `, [limit]);
            
            return feedback;
        } catch (error) {
            console.error('Error fetching feedback:', error);
            return [];
        }
    }

    async getFeedbackStats() {
        try {
            const stats = await this.all(`
                SELECT 
                    u.role,
                    COUNT(*) as count,
                    AVG(rating) as avg_rating,
                    MIN(rating) as min_rating,
                    MAX(rating) as max_rating
                FROM user_feedback uf
                LEFT JOIN users u ON uf.user_id = u.id
                GROUP BY u.role
                ORDER BY count DESC
            `);
            
            return stats;
        } catch (error) {
            console.error('Error fetching feedback stats:', error);
            return [];
        }
    }

    async logPerformanceWithFeedback(sessionId, participantId, metrics, feedbackData = {}) {
        // Log performance metrics
        await this.logPerformance(sessionId, participantId, 'performance', 'Performance metrics collected', {
            timestamp: new Date().toISOString(),
            ...metrics
        }, metrics);

        // If performance is poor, suggest feedback
        if (metrics.latency_ms > 300 || metrics.packet_loss_pct > 5 || metrics.throughput_mbps < 2) {
            await this.logPerformance(sessionId, participantId, 'warning', 'Poor performance detected - feedback suggested', {
                latency_ms: metrics.latency_ms,
                packet_loss_pct: metrics.packet_loss_pct,
                throughput_mbps: metrics.throughput_mbps,
                suggestion: 'User should be prompted to submit feedback'
            }, metrics);
        }
    }

    // Analytics methods
    async getSessionStats(sessionId) {
        const stats = await this.get(`
            SELECT 
                s.*,
                COUNT(DISTINCT cs.id) as content_shares,
                COUNT(DISTINCT pl.id) as performance_logs
            FROM sessions s
            LEFT JOIN content_shares cs ON s.id = cs.session_id
            LEFT JOIN performance_logs pl ON s.id = pl.session_id
            WHERE s.id = ?
            GROUP BY s.id
        `, [sessionId]);
        return stats;
    }

    // Enhanced content tracking methods
    async startContentShare(sessionId, userId, shareType, contentTitle = null, contentDescription = null, contentMetadata = null, slideCount = null) {
        try {
            const metadata = contentMetadata ? JSON.stringify(contentMetadata) : null;
            const result = await this.run(
                `INSERT INTO content_shares (session_id, user_id, share_type, content_title, content_description, content_metadata, slide_count, is_active) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
                [sessionId, userId, shareType, contentTitle, contentDescription, metadata, slideCount]
            );
            return result.id;
        } catch (error) {
            console.error('Error starting content share:', error);
            throw error;
        }
    }

    async updateContentShare(shareId, updates = {}) {
        try {
            const fields = [];
            const values = [];
            
            if (updates.current_slide !== undefined) {
                fields.push('current_slide = ?');
                values.push(updates.current_slide);
            }
            if (updates.content_title !== undefined) {
                fields.push('content_title = ?');
                values.push(updates.content_title);
            }
            if (updates.content_description !== undefined) {
                fields.push('content_description = ?');
                values.push(updates.content_description);
            }
            if (updates.content_metadata !== undefined) {
                fields.push('content_metadata = ?');
                values.push(updates.content_metadata ? JSON.stringify(updates.content_metadata) : null);
            }
            
            if (fields.length > 0) {
                values.push(shareId);
                await this.run(
                    `UPDATE content_shares SET ${fields.join(', ')} WHERE id = ?`,
                    values
                );
            }
        } catch (error) {
            console.error('Error updating content share:', error);
            throw error;
        }
    }

    async endContentShare(shareId) {
        try {
            const share = await this.get('SELECT started_at FROM content_shares WHERE id = ?', [shareId]);
            if (share) {
                const duration = Math.floor((Date.now() - new Date(share.started_at).getTime()) / 1000);
                await this.run(
                    'UPDATE content_shares SET ended_at = CURRENT_TIMESTAMP, duration_seconds = ?, is_active = 0 WHERE id = ?',
                    [duration, shareId]
                );
            }
        } catch (error) {
            console.error('Error ending content share:', error);
            throw error;
        }
    }

    async getActiveContentShares(sessionId) {
        return await this.all(
            'SELECT cs.*, u.name as user_name, u.email as user_email FROM content_shares cs ' +
            'JOIN users u ON cs.user_id = u.id WHERE cs.session_id = ? AND cs.is_active = 1 ORDER BY cs.started_at DESC',
            [sessionId]
        );
    }

    async getSessionContentHistory(sessionId) {
        return await this.all(
            'SELECT cs.*, u.name as user_name, u.email as user_email FROM content_shares cs ' +
            'JOIN users u ON cs.user_id = u.id WHERE cs.session_id = ? ORDER BY cs.started_at DESC',
            [sessionId]
        );
    }

    async detectContentType(title, streamSettings = null) {
        if (!title) return 'screen';
        
        const titleLower = title.toLowerCase();
        
        // Enhanced detection using both title and stream properties
        const detectedTypes = [];
        
        // Check for file extensions in title
        const fileExtensions = {
            '.ppt': 'presentation',
            '.pptx': 'presentation', 
            '.pdf': 'document',
            '.doc': 'document',
            '.docx': 'document',
            '.xls': 'document',
            '.xlsx': 'document',
            '.mp4': 'video',
            '.avi': 'video',
            '.mov': 'video',
            '.wmv': 'video',
            '.mp3': 'audio',
            '.wav': 'audio',
            '.flac': 'audio'
        };
        
        for (const [ext, type] of Object.entries(fileExtensions)) {
            if (titleLower.includes(ext)) {
                detectedTypes.push(type);
            }
        }
        
        // Application-specific detection
        const applications = {
            'powerpoint': 'presentation',
            'presentation': 'presentation',
            'slide': 'presentation',
            'google slides': 'presentation',
            'keynote': 'presentation',
            'pdf': 'document',
            'adobe acrobat': 'document',
            'word': 'document',
            'microsoft word': 'document',
            'google docs': 'document',
            'excel': 'document',
            'microsoft excel': 'document',
            'google sheets': 'document',
            'vs code': 'application',
            'visual studio': 'application',
            'intellij': 'application',
            'eclipse': 'application',
            'photoshop': 'application',
            'illustrator': 'application',
            'chrome': 'application',
            'firefox': 'application',
            'edge': 'application',
            'youtube': 'video',
            'vlc': 'video',
            'media player': 'video',
            'spotify': 'audio',
            'itunes': 'audio',
            'windows media player': 'audio'
        };
        
        for (const [app, type] of Object.entries(applications)) {
            if (titleLower.includes(app)) {
                detectedTypes.push(type);
            }
        }
        
        // Analyze stream settings if available
        if (streamSettings) {
            const { width, height, frameRate } = streamSettings;
            
            // Common presentation resolutions (4:3 or 16:9)
            const presentationRatios = ['4:3', '16:9', '16:10'];
            const ratio = width && height ? `${width}:${height}` : '';
            
            // High resolution with standard aspect ratio might indicate presentation
            if (width >= 1280 && height >= 720 && presentationRatios.some(r => ratio.includes(r))) {
                if (!detectedTypes.includes('presentation')) {
                    detectedTypes.push('presentation');
                }
            }
            
            // Video content typically has specific frame rates
            if (frameRate >= 24 && frameRate <= 60) {
                if (!detectedTypes.includes('video')) {
                    detectedTypes.push('video');
                }
            }
        }
        
        // Priority order: presentation > document > video > audio > application > screen
        const priorityOrder = ['presentation', 'document', 'video', 'audio', 'application'];
        
        for (const priority of priorityOrder) {
            if (detectedTypes.includes(priority)) {
                return priority;
            }
        }
        
        // Default to screen if nothing detected
        return 'screen';
    }
    async markAttendance(sessionId, userId) {
        try {
            // Check if attendance already exists for this user and session
            const existing = await this.get(
                'SELECT id, left_at FROM attendance WHERE session_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1',
                [sessionId, userId]
            );
            
            if (!existing) {
                // No record exists, create new one
                await this.run(
                    'INSERT INTO attendance (session_id, user_id) VALUES (?, ?)',
                    [sessionId, userId]
                );
            } else if (existing.left_at) {
                // User left before, create new attendance record for rejoining
                await this.run(
                    'INSERT INTO attendance (session_id, user_id) VALUES (?, ?)',
                    [sessionId, userId]
                );
            }
            // If existing record exists and left_at is NULL, user is still in session - do nothing
        } catch (error) {
            console.error('Error marking attendance:', error);
        }
    }

    async updateAttendanceLeave(sessionId, userId) {
        try {
            const attendance = await this.get(
                'SELECT id, joined_at FROM attendance WHERE session_id = ? AND user_id = ? AND left_at IS NULL',
                [sessionId, userId]
            );
            
            if (attendance) {
                const duration = Math.floor((Date.now() - new Date(attendance.joined_at).getTime()) / 1000);
                await this.run(
                    'UPDATE attendance SET left_at = CURRENT_TIMESTAMP, duration_seconds = ? WHERE id = ?',
                    [duration, attendance.id]
                );
            }
        } catch (error) {
            console.error('Error updating attendance leave:', error);
        }
    }

    async getSessionAttendance(sessionId) {
        return await this.all(`
            SELECT 
                u.name,
                u.email,
                a.joined_at,
                a.left_at,
                a.duration_seconds
            FROM attendance a
            JOIN users u ON a.user_id = u.id
            WHERE a.session_id = ?
            ORDER BY a.joined_at ASC
        `, [sessionId]);
    }

    async exportAttendanceCSV(sessionId) {
        const attendance = await this.getSessionAttendance(sessionId);
        const session = await this.getSessionByDbId(sessionId);
        
        let csv = `Attendance Report - ${session.room_id}\n`;
        csv += `Session: ${session.title || 'N/A'}\n`;
        csv += `Presenter: ${session.presenter_name}\n`;
        csv += `Date: ${new Date(session.created_at).toLocaleString()}\n\n`;
        csv += `Name,Email,Joined At,Left At,Duration (minutes)\n`;
        
        attendance.forEach(record => {
            const joinedAt = new Date(record.joined_at).toLocaleString();
            const leftAt = record.left_at ? new Date(record.left_at).toLocaleString() : 'Still in session';
            const duration = record.duration_seconds ? Math.round(record.duration_seconds / 60) : 'N/A';
            
            csv += `"${record.name}","${record.email}","${joinedAt}","${leftAt}","${duration}"\n`;
        });
        
        return csv;
    }

    // Enhanced performance logging with detailed metrics
    async logPerformance(sessionId, participantId, logType, message, metrics = {}) {
        try {
            // Ensure we have values even if metrics are empty
            const performanceData = {
                latency_ms: metrics.latency_ms || null,
                throughput_mbps: metrics.throughput_mbps || null,
                packet_loss_pct: metrics.packet_loss_pct || null,
                jitter_ms: metrics.jitter_ms || null,
                connection_time_ms: metrics.connection_time_ms || null,
                screen_share_fps: metrics.screen_share_fps || null,
                video_bitrate_kbps: metrics.video_bitrate_kbps || null,
                audio_bitrate_kbps: metrics.audio_bitrate_kbps || null,
                cpu_usage_pct: metrics.cpu_usage_pct || null,
                memory_usage_mb: metrics.memory_usage_mb || null,
                network_type: metrics.network_type || null,
                browser_info: metrics.browser_info || null,
                timestamp: Date.now()
            };

            await this.run(
                `INSERT INTO performance_logs 
                (session_id, participant_id, latency_ms, throughput_mbps, packet_loss_pct, jitter_ms, log_type, message, details, recorded_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [
                    sessionId,
                    participantId,
                    performanceData.latency_ms,
                    performanceData.throughput_mbps,
                    performanceData.packet_loss_pct,
                    performanceData.jitter_ms,
                    logType,
                    message,
                    JSON.stringify(performanceData)
                ]
            );
        } catch (error) {
            console.error('Error logging performance:', error);
        }
    }

    async getPerformanceLogs(sessionId = null, logType = null, limit = 100) {
        try {
            let query = `
                SELECT pl.*, u.name as participant_name, u.email as participant_email, s.room_id
                FROM performance_logs pl
                LEFT JOIN users u ON pl.participant_id = u.id
                LEFT JOIN sessions s ON pl.session_id = s.id
                WHERE 1=1
            `;
            
            const params = [];
            
            if (sessionId) {
                query += ' AND pl.session_id = (SELECT id FROM sessions WHERE room_id = ?)';
                params.push(sessionId);
            }
            
            if (logType) {
                query += ' AND pl.log_type = ?';
                params.push(logType);
            }
            
            query += ' ORDER BY pl.recorded_at DESC LIMIT ?';
            params.push(limit);
            
            const logs = await this.all(query, params);
            
            // Parse details for each log
            logs.forEach(log => {
                if (log.details) {
                    try {
                        log.details = JSON.parse(log.details);
                    } catch (e) {
                        log.details = null;
                    }
                }
            });
            
            return logs;
        } catch (error) {
            console.error('Error fetching performance logs:', error);
            return [];
        }
    }

    async getPerformanceStats(sessionId = null) {
        try {
            let whereClause = '';
            const params = [];
            
            if (sessionId) {
                whereClause = 'WHERE session_id = (SELECT id FROM sessions WHERE room_id = ?)';
                params.push(sessionId);
            }
            
            const stats = await this.all(`
                SELECT 
                    log_type,
                    COUNT(*) as count,
                    MAX(recorded_at) as last_occurrence,
                    AVG(latency_ms) as avg_latency,
                    AVG(throughput_mbps) as avg_throughput,
                    AVG(packet_loss_pct) as avg_packet_loss,
                    AVG(jitter_ms) as avg_jitter
                FROM performance_logs 
                ${whereClause}
                GROUP BY log_type
                ORDER BY count DESC
            `, params);
            
            return stats;
        } catch (error) {
            console.error('Error fetching performance stats:', error);
            return [];
        }
    }

    async logConnectionEvent(sessionId, participantId, eventType, details = {}, networkMetrics = {}) {
        await this.logPerformance(sessionId, participantId, 'connection', `${eventType}: ${details.message || 'User connection event'}`, {
            eventType,
            timestamp: new Date().toISOString(),
            ...details
        }, networkMetrics);
    }

    async logScreenShareEvent(sessionId, participantId, eventType, contentDetails = {}, networkMetrics = {}) {
        await this.logPerformance(sessionId, participantId, 'screen_share', `${eventType}: ${contentDetails.title || 'Screen share'}`, {
            eventType,
            contentType: contentDetails.contentType,
            title: contentDetails.title,
            duration: contentDetails.duration,
            timestamp: new Date().toISOString(),
            ...contentDetails
        }, networkMetrics);
    }

    async logChatEvent(sessionId, participantId, messageDetails = {}, networkMetrics = {}) {
        await this.logPerformance(sessionId, participantId, 'chat', `Chat message: ${messageDetails.message?.substring(0, 50) || 'Empty message'}...`, {
            messageLength: messageDetails.message?.length || 0,
            senderRole: messageDetails.senderRole,
            timestamp: new Date().toISOString(),
            ...messageDetails
        }, networkMetrics);
    }

    async logError(sessionId, participantId, errorType, errorMessage, errorDetails = {}, networkMetrics = {}) {
        await this.logPerformance(sessionId, participantId, 'error', `${errorType}: ${errorMessage}`, {
            errorType,
            stack: errorDetails.stack,
            timestamp: new Date().toISOString(),
            ...errorDetails
        }, networkMetrics);
    }

    async logPerformanceMetrics(sessionId, participantId, metrics = {}) {
        await this.logPerformance(sessionId, participantId, 'performance', 'Performance metrics collected', {
            cpuUsage: metrics.cpuUsage,
            memoryUsage: metrics.memoryUsage,
            participantCount: metrics.participantCount,
            timestamp: new Date().toISOString(),
            ...metrics
        }, {
            latency_ms: metrics.latency_ms,
            throughput_mbps: metrics.throughput_mbps,
            packet_loss_pct: metrics.packet_loss_pct,
            jitter_ms: metrics.jitter_ms
        });
    }

    // Close database connection
    close() {
        if (this.db) {
            this.db.close((err) => {
                if (err) {
                    console.error('Error closing database:', err.message);
                } else {
                    console.log('Database connection closed.');
                }
            });
        }
    }
}

module.exports = new Database();
