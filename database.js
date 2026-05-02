const fs = require('fs');
const path = require('path');
const standardSqlite3 = require('sqlite3').verbose();
let sqlcipherSqlite3 = null;

try {
    sqlcipherSqlite3 = require('@journeyapps/sqlcipher').verbose();
} catch (error) {
    sqlcipherSqlite3 = null;
}

const DB_PASSPHRASE = String(process.env.DB_PASSPHRASE || '');
const DB_CIPHER_COMPATIBILITY = Math.max(1, Number(process.env.DB_CIPHER_COMPATIBILITY || 4));
const ADMIN_ACTION_CODE = String(
    process.env.ADMIN_ACTION_CODE ||
    process.env.ADMIN_PASSWORD ||
    'MustMirror@Admin123'
);
const sqlite3 = DB_PASSPHRASE ? (sqlcipherSqlite3 || standardSqlite3) : standardSqlite3;
const PROJECT_DB_PATH = path.join(__dirname, 'wireless_screen_sharing.db');

const DB_PATH = process.env.DB_PATH
    ? path.resolve(__dirname, process.env.DB_PATH)
    : PROJECT_DB_PATH;

function escapeSqlString(value = '') {
    return String(value).replace(/'/g, "''");
}

function openDriverDatabase(filePath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filePath, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve(db);
            }
        });
    });
}

function closeDriverDatabase(db) {
    return new Promise((resolve, reject) => {
        if (!db) {
            resolve();
            return;
        }

        db.close((err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

function rawRun(db, sql) {
    return new Promise((resolve, reject) => {
        db.run(sql, function(err) {
            if (err) reject(err);
            else resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

function rawGet(db, sql) {
    return new Promise((resolve, reject) => {
        db.get(sql, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function removeSidecarFiles(filePath) {
    for (const suffix of ['-wal', '-shm']) {
        const sidecarPath = `${filePath}${suffix}`;
        if (fs.existsSync(sidecarPath)) {
            fs.unlinkSync(sidecarPath);
        }
    }
}

function isMatchingConfirmationCode(code = '') {
    return String(code || '').trim() && String(code || '').trim() === ADMIN_ACTION_CODE;
}

function ensureParentDirectory(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

class Database {
    constructor() {
        this.db = null;
        this.usersEmailRequired = false;
    }

    // Initialize database connection and create tables
    async initialize() {
        try {
            if (DB_PASSPHRASE && !sqlcipherSqlite3) {
                throw new Error('DB_PASSPHRASE is set but the SQLCipher driver is not installed.');
            }
            this.db = await this.openConfiguredDatabase();
            console.log(`Connected to ${DB_PASSPHRASE ? 'SQLCipher' : 'SQLite'} database.`);
            await this.createTables();
        } catch (error) {
            console.error('Error opening database:', error);
            throw error;
        }
    }

    async openConfiguredDatabase() {
        ensureParentDirectory(DB_PATH);
        const dbExists = fs.existsSync(DB_PATH);
        const migrationSourcePath = DB_PATH !== PROJECT_DB_PATH && fs.existsSync(PROJECT_DB_PATH)
            ? PROJECT_DB_PATH
            : DB_PATH;

        if (!dbExists) {
            if (DB_PASSPHRASE && migrationSourcePath && fs.existsSync(migrationSourcePath) && migrationSourcePath !== DB_PATH) {
                await this.encryptExistingPlaintextDatabase(migrationSourcePath, DB_PATH);
                const encryptedDb = await openDriverDatabase(DB_PATH);
                await this.applySqlCipherKey(encryptedDb, DB_PASSPHRASE);
                await this.verifyReadableDatabase(encryptedDb);
                return encryptedDb;
            }

            const freshDb = await openDriverDatabase(DB_PATH);
            if (DB_PASSPHRASE) {
                try {
                    await this.applySqlCipherKey(freshDb, DB_PASSPHRASE);
                } catch (error) {
                    await closeDriverDatabase(freshDb).catch(() => {});
                    throw error;
                }
            }
            return freshDb;
        }

        if (!DB_PASSPHRASE) {
            const plainDb = await openDriverDatabase(DB_PATH);
            try {
                await this.verifyReadableDatabase(plainDb);
                return plainDb;
            } catch (error) {
                await closeDriverDatabase(plainDb).catch(() => {});
                throw new Error('Database appears encrypted. Set DB_PASSPHRASE to open it.');
            }
        }

        const keyedDb = await openDriverDatabase(DB_PATH);
        try {
            await this.applySqlCipherKey(keyedDb, DB_PASSPHRASE);
            await this.verifyReadableDatabase(keyedDb);
            return keyedDb;
        } catch (keyedError) {
            await closeDriverDatabase(keyedDb).catch(() => {});

            const plainDb = await openDriverDatabase(DB_PATH);
            try {
                await this.verifyReadableDatabase(plainDb);
                await closeDriverDatabase(plainDb);
                await this.encryptExistingPlaintextDatabase(DB_PATH);

                const encryptedDb = await openDriverDatabase(DB_PATH);
                await this.applySqlCipherKey(encryptedDb, DB_PASSPHRASE);
                await this.verifyReadableDatabase(encryptedDb);
                return encryptedDb;
            } catch (plainError) {
                await closeDriverDatabase(plainDb).catch(() => {});
                const reason = plainError?.message ? ` ${plainError.message}` : '';
                throw new Error(`Failed to open the database with SQLCipher. The passphrase may be incorrect, the driver may not support encrypted file writes in this environment, or the file may be corrupted.${reason}`);
            }
        }

        throw new Error('Database could not be opened.');
    }

    async applySqlCipherKey(db, passphrase) {
        if (!passphrase) {
            return;
        }

        await rawRun(db, `PRAGMA cipher_compatibility = ${DB_CIPHER_COMPATIBILITY}`);
        await rawRun(db, `PRAGMA key = '${escapeSqlString(passphrase)}'`);
    }

    async verifyReadableDatabase(db) {
        await rawGet(db, 'SELECT COUNT(*) AS table_count FROM sqlite_master');
    }

    async encryptExistingPlaintextDatabase(sourcePath = DB_PATH, targetPath = DB_PATH) {
        ensureParentDirectory(targetPath);
        const tempEncryptedPath = sourcePath === targetPath
            ? `${targetPath}.sqlcipher.tmp`
            : `${targetPath}.tmp`;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${sourcePath}.plaintext-backup-${timestamp}`;

        if (fs.existsSync(tempEncryptedPath)) {
            fs.unlinkSync(tempEncryptedPath);
        }
        removeSidecarFiles(tempEncryptedPath);

        const plaintextDb = await openDriverDatabase(sourcePath);
        try {
            const attachedPath = escapeSqlString(tempEncryptedPath);
            const escapedPassphrase = escapeSqlString(DB_PASSPHRASE);

            await rawRun(plaintextDb, `ATTACH DATABASE '${attachedPath}' AS encrypted KEY '${escapedPassphrase}'`);
            await rawRun(plaintextDb, `PRAGMA encrypted.cipher_compatibility = ${DB_CIPHER_COMPATIBILITY}`);
            await rawRun(plaintextDb, `SELECT sqlcipher_export('encrypted')`);
            await rawRun(plaintextDb, 'DETACH DATABASE encrypted');
        } catch (error) {
            if (fs.existsSync(tempEncryptedPath)) {
                fs.unlinkSync(tempEncryptedPath);
            }
            removeSidecarFiles(tempEncryptedPath);
            throw new Error(`SQLCipher migration failed: ${error.message}`);
        } finally {
            await closeDriverDatabase(plaintextDb);
        }

        if (sourcePath === targetPath) {
            removeSidecarFiles(sourcePath);
            fs.renameSync(sourcePath, backupPath);
            fs.renameSync(tempEncryptedPath, targetPath);
        } else {
            fs.copyFileSync(sourcePath, backupPath);
            if (fs.existsSync(targetPath)) {
                fs.unlinkSync(targetPath);
            }
            fs.renameSync(tempEncryptedPath, targetPath);
        }
        console.log(`Existing plaintext database encrypted. Backup saved to ${backupPath}`);
    }

    async createTables() {
        try {
            // Baseline safety and consistency pragmas.
            await this.run('PRAGMA foreign_keys = ON');
            await this.run('PRAGMA journal_mode = WAL');
            await this.run('PRAGMA busy_timeout = 5000');
            await this.run('PRAGMA trusted_schema = OFF');

            // Create tables with IF NOT EXISTS to avoid conflicts
            await this.run(`
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    email TEXT UNIQUE,
                    role TEXT NOT NULL CHECK (role IN ('presenter', 'student', 'admin')),
                    socket_id TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_active DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await this.detectUsersSchemaConstraints();

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

            await this.dropLegacyContentSharesTable();
            
            await this.run(`
                CREATE TABLE IF NOT EXISTS attendance (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    left_at DATETIME,
                    duration_minutes INTEGER,
                    FOREIGN KEY (session_id) REFERENCES sessions (id),
                    FOREIGN KEY (user_id) REFERENCES users (id)
                )
            `);
            await this.migrateAttendanceTable();
            await this.normalizeAttendanceDurations();

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
                    recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (session_id) REFERENCES sessions (id),
                    FOREIGN KEY (participant_id) REFERENCES users (id)
                )
            `);
            await this.migratePerformanceLogsTable();

            // User feedback table - simplified with message
            await this.run(`
                CREATE TABLE IF NOT EXISTS user_feedback (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    session_id INTEGER,
                    feedback_type TEXT NOT NULL DEFAULT 'general' CHECK (feedback_type IN ('bug_report', 'feature_request', 'general', 'rating')),
                    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
                    subject TEXT,
                    message TEXT NOT NULL,
                    issue_type TEXT,
                    description TEXT,
                    screenshot_name TEXT,
                    screenshot_type TEXT,
                    screenshot_path TEXT,
                    status TEXT DEFAULT 'pending',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users (id),
                    FOREIGN KEY (session_id) REFERENCES sessions (id)
                )
            `);

            await this.run(`
                CREATE TABLE IF NOT EXISTS admin_users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    salt TEXT NOT NULL,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    last_login TIMESTAMP
                )
            `);

            await this.migrateFeedbackTable();

            console.log('All database tables created successfully.');
        } catch (error) {
            console.error('Error creating tables:', error);
            throw error;
        }
    }

    async dropLegacyContentSharesTable() {
        try {
            const tableInfo = await this.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_shares'");
            if (tableInfo.length > 0) {
                console.log('Removing legacy content_shares table...');
                await this.run('DROP TABLE IF EXISTS content_shares', [], { allowDangerous: true, internalSystemOperation: true });
                await this.run("DELETE FROM sqlite_sequence WHERE name = 'content_shares'");
            }
        } catch (error) {
            console.error('Error removing legacy content_shares table:', error);
        }
    }

    async migratePerformanceLogsTable() {
        try {
            const tableInfo = await this.all("PRAGMA table_info(performance_logs)");
            const columns = tableInfo.map(column => column.name);
            const needsRebuild =
                !columns.includes('log_id') ||
                !columns.includes('participant_id') ||
                columns.includes('details');

            if (needsRebuild) {
                console.log('Rebuilding performance_logs table to current schema...');
                await this.rebuildTable(
                    'performance_logs',
                    `
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
                            recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                            FOREIGN KEY (session_id) REFERENCES sessions (id),
                            FOREIGN KEY (participant_id) REFERENCES users (id)
                        )
                    `,
                    `
                        INSERT INTO performance_logs (
                            log_id, session_id, participant_id, latency_ms, throughput_mbps,
                            packet_loss_pct, jitter_ms, log_type, message, recorded_at
                        )
                        SELECT
                            ${columns.includes('log_id') ? 'log_id' : 'id'},
                            session_id,
                            ${columns.includes('participant_id') ? 'participant_id' : (columns.includes('user_id') ? 'user_id' : 'NULL')},
                            ${columns.includes('latency_ms') ? 'latency_ms' : 'NULL'},
                            ${columns.includes('throughput_mbps') ? 'throughput_mbps' : 'NULL'},
                            ${columns.includes('packet_loss_pct') ? 'packet_loss_pct' : 'NULL'},
                            ${columns.includes('jitter_ms') ? 'jitter_ms' : 'NULL'},
                            log_type,
                            message,
                            ${columns.includes('recorded_at') ? 'recorded_at' : (columns.includes('created_at') ? 'created_at' : 'CURRENT_TIMESTAMP')}
                        FROM performance_logs__old
                    `
                );
            }

            await this.run(`
                UPDATE performance_logs
                SET
                    latency_ms = COALESCE(latency_ms, 0),
                    throughput_mbps = COALESCE(throughput_mbps, 0),
                    packet_loss_pct = COALESCE(packet_loss_pct, 0),
                    jitter_ms = COALESCE(jitter_ms, 0)
            `);
        } catch (error) {
            console.error('Error migrating performance_logs table:', error);
        }
    }

    async migrateFeedbackTable() {
        try {
            const tableInfo = await this.all("PRAGMA table_info(user_feedback)");
            const columns = tableInfo.map(column => column.name);
            const needsRebuild =
                columns.includes('screenshot_data') ||
                !columns.includes('session_id') ||
                !columns.includes('feedback_type') ||
                !columns.includes('subject') ||
                !columns.includes('issue_type') ||
                !columns.includes('description') ||
                !columns.includes('screenshot_name') ||
                !columns.includes('screenshot_type') ||
                !columns.includes('screenshot_path') ||
                !columns.includes('status');

            if (needsRebuild) {
                console.log('Rebuilding user_feedback table to current schema...');
                await this.rebuildTable(
                    'user_feedback',
                    `
                        CREATE TABLE user_feedback (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            user_id INTEGER NOT NULL,
                            session_id INTEGER,
                            feedback_type TEXT NOT NULL DEFAULT 'general' CHECK (feedback_type IN ('bug_report', 'feature_request', 'general', 'rating')),
                            rating INTEGER CHECK (rating >= 1 AND rating <= 5),
                            subject TEXT,
                            message TEXT NOT NULL,
                            issue_type TEXT,
                            description TEXT,
                            screenshot_name TEXT,
                            screenshot_type TEXT,
                            screenshot_path TEXT,
                            status TEXT DEFAULT 'pending',
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            FOREIGN KEY (user_id) REFERENCES users (id),
                            FOREIGN KEY (session_id) REFERENCES sessions (id)
                        )
                    `,
                    `
                        INSERT INTO user_feedback (
                            id, user_id, session_id, feedback_type, rating, subject, message,
                            issue_type, description, screenshot_name, screenshot_type, screenshot_path,
                            status, created_at
                        )
                        SELECT
                            id,
                            user_id,
                            ${columns.includes('session_id') ? 'session_id' : 'NULL'},
                            ${columns.includes('feedback_type') ? "COALESCE(feedback_type, 'general')" : "'general'"},
                            rating,
                            ${columns.includes('subject') ? 'subject' : 'NULL'},
                            COALESCE(message, ${columns.includes('description') ? 'description' : 'NULL'}, ${columns.includes('subject') ? 'subject' : 'NULL'}, 'Feedback report'),
                            ${columns.includes('issue_type') ? 'issue_type' : 'NULL'},
                            COALESCE(${columns.includes('description') ? 'description' : 'NULL'}, message),
                            ${columns.includes('screenshot_name') ? 'screenshot_name' : 'NULL'},
                            ${columns.includes('screenshot_type') ? 'screenshot_type' : 'NULL'},
                            ${columns.includes('screenshot_path') ? 'screenshot_path' : 'NULL'},
                            ${columns.includes('status') ? "COALESCE(status, 'pending')" : "'pending'"},
                            ${columns.includes('created_at') ? 'created_at' : 'CURRENT_TIMESTAMP'}
                        FROM user_feedback__old
                    `
                );
            }
        } catch (error) {
            console.error('Error migrating user_feedback table:', error);
        }
    }

    async migrateAttendanceTable() {
        try {
            const tableInfo = await this.all("PRAGMA table_info(attendance)");
            const columns = tableInfo.map(column => column.name);
            const needsRebuild = columns.includes('duration_seconds') || !columns.includes('duration_minutes');

            if (needsRebuild) {
                console.log('Rebuilding attendance table to store minutes...');
                await this.rebuildTable(
                    'attendance',
                    `
                        CREATE TABLE attendance (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            session_id INTEGER NOT NULL,
                            user_id INTEGER NOT NULL,
                            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            left_at DATETIME,
                            duration_minutes INTEGER,
                            FOREIGN KEY (session_id) REFERENCES sessions (id),
                            FOREIGN KEY (user_id) REFERENCES users (id)
                        )
                    `,
                    `
                        INSERT INTO attendance (
                            id, session_id, user_id, joined_at, left_at, duration_minutes
                        )
                        SELECT
                            id,
                            session_id,
                            user_id,
                            joined_at,
                            left_at,
                            COALESCE(
                                ${columns.includes('duration_minutes') ? 'duration_minutes' : 'NULL'},
                                CASE
                                    WHEN ${columns.includes('duration_seconds') ? 'duration_seconds IS NOT NULL' : '0'} THEN MAX(1, ROUND(duration_seconds / 60.0))
                                    WHEN left_at IS NOT NULL THEN MAX(1, ROUND((julianday(left_at) - julianday(joined_at)) * 24 * 60))
                                    ELSE NULL
                                END
                            )
                        FROM attendance__old
                    `
                );
            }
        } catch (error) {
            console.error('Error migrating attendance table:', error);
        }
    }

    async normalizeAttendanceDurations() {
        try {
            await this.run(`
                UPDATE attendance
                SET duration_minutes = CASE
                    WHEN left_at IS NOT NULL THEN MAX(
                        1,
                        CAST(ROUND((julianday(left_at) - julianday(joined_at)) * 24 * 60) AS INTEGER)
                    )
                    ELSE NULL
                END
            `);
        } catch (error) {
            console.error('Error normalizing attendance durations:', error);
        }
    }

    async rebuildTable(tableName, createSql, insertSql) {
        await this.run('PRAGMA foreign_keys = OFF');
        try {
            await this.run('BEGIN TRANSACTION');
            await this.run(`ALTER TABLE ${tableName} RENAME TO ${tableName}__old`);
            await this.run(createSql);
            await this.run(insertSql);
            await this.run(`DROP TABLE ${tableName}__old`, [], { allowDangerous: true, internalSystemOperation: true });
            await this.run('COMMIT');
        } catch (error) {
            try {
                await this.run('ROLLBACK');
            } catch (_) {}
            throw error;
        } finally {
            await this.run('PRAGMA foreign_keys = ON');
        }
    }

    async detectUsersSchemaConstraints() {
        try {
            const tableInfo = await this.all("PRAGMA table_info(users)");
            const emailColumn = tableInfo.find(column => column.name === 'email');
            this.usersEmailRequired = Boolean(emailColumn && emailColumn.notnull);
        } catch (error) {
            this.usersEmailRequired = false;
            console.error('Error checking users schema constraints:', error);
        }
    }

    // Helper method to run SQL queries
    isDangerousSql(sql) {
        if (!sql) return false;
        const normalized = String(sql).toUpperCase().replace(/\s+/g, ' ').trim();
        return (
            normalized.includes('DROP TABLE') ||
            normalized.includes('DROP INDEX') ||
            normalized.includes('DROP VIEW') ||
            normalized.includes('DROP TRIGGER') ||
            normalized.includes('ALTER TABLE') ||
            normalized.includes('DETACH DATABASE') ||
            normalized.includes('PRAGMA WRITABLE_SCHEMA')
        );
    }

    canRunDangerousSql(options = {}) {
        return Boolean(
            options.internalSystemOperation ||
            (options.allowDangerous && isMatchingConfirmationCode(options.confirmationCode))
        );
    }

    run(sql, params = [], options = {}) {
        return new Promise((resolve, reject) => {
            if (this.isDangerousSql(sql) && !this.canRunDangerousSql(options)) {
                reject(new Error('Dangerous SQL blocked. A valid admin confirmation code is required for schema or table changes.'));
                return;
            }
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
            if (this.isDangerousSql(sql)) {
                reject(new Error('Dangerous SQL blocked'));
                return;
            }
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
            if (this.isDangerousSql(sql)) {
                reject(new Error('Dangerous SQL blocked'));
                return;
            }
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
    async createUser(name, email, role, connectionAddress = null) {
        try {
            const normalizedEmail = email && String(email).trim() ? String(email).trim().toLowerCase() : null;
            const safeEmail = normalizedEmail || (
                this.usersEmailRequired
                    ? `${String(role || 'user').toLowerCase()}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@local.must`
                    : null
            );
            
            const result = await this.run(
                'INSERT INTO users (name, email, role, socket_id, last_active) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
                [name, safeEmail, role, connectionAddress]
            );
            return result.id;
        } catch (error) {
            if (error && error.message && error.message.includes('UNIQUE constraint failed: users.email') && email) {
                const existingUser = await this.getUserByEmail(email);
                if (existingUser) {
                    await this.run(
                        'UPDATE users SET name = ?, role = ?, socket_id = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?',
                        [name, role, connectionAddress, existingUser.id]
                    );
                    return existingUser.id;
                }
            }
            console.error('Error creating user:', error);
            throw error;
        }
    }

    async updateUserSocket(userId, connectionAddress) {
        await this.run(
            'UPDATE users SET socket_id = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?',
            [connectionAddress, userId]
        );
    }

    async getUserByEmail(email) {
        const normalizedEmail = email && String(email).trim() ? String(email).trim().toLowerCase() : null;
        return await this.get('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
    }

    async getUserBySocketId(socketId) {
        return await this.get('SELECT * FROM users WHERE socket_id = ?', [socketId]);
    }

    // Session management methods
    async createSession(roomId, presenterId, presenterName, title = null) {
        try {
            await this.run(
                `INSERT INTO sessions (room_id, presenter_id, presenter_name, title, status, created_at, ended_at)
                 VALUES (?, ?, ?, ?, "active", CURRENT_TIMESTAMP, NULL)
                 ON CONFLICT(room_id) DO UPDATE SET
                    presenter_id = excluded.presenter_id,
                    presenter_name = excluded.presenter_name,
                    title = excluded.title,
                    status = "active",
                    created_at = CURRENT_TIMESTAMP,
                    ended_at = NULL,
                    participant_count = 0`,
                [roomId, presenterId, presenterName, title]
            );

            const session = await this.get('SELECT id FROM sessions WHERE room_id = ?', [roomId]);
            return session?.id || null;
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

    // Simplified user feedback methods
    async submitFeedback(userId, rating, payload = {}) {
        try {
            const feedbackPayload = (typeof payload === 'object' && payload !== null) ? payload : { message: payload };
            const normalizedMessage = feedbackPayload.message || feedbackPayload.description || 'Feedback report';
            const normalizedFeedbackType = feedbackPayload.feedbackType || 'general';
            const normalizedSubject = feedbackPayload.subject || feedbackPayload.issueType || 'Screen sharing issue';
            const result = await this.run(
                `INSERT INTO user_feedback 
                (user_id, session_id, feedback_type, rating, subject, message, issue_type, description, screenshot_name, screenshot_type, screenshot_path, status) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    userId,
                    feedbackPayload.sessionId || null,
                    normalizedFeedbackType,
                    rating,
                    normalizedSubject,
                    normalizedMessage,
                    feedbackPayload.issueType || null,
                    feedbackPayload.description || normalizedMessage,
                    feedbackPayload.screenshotName || null,
                    feedbackPayload.screenshotType || null,
                    feedbackPayload.screenshotPath || null,
                    feedbackPayload.status || 'pending'
                ]
            );
            return result.id;
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

    async updateFeedbackStatus(feedbackId, status) {
        await this.run(
            'UPDATE user_feedback SET status = ? WHERE id = ?',
            [status, feedbackId]
        );
    }

    async getAdminByUsername(username) {
        const normalizedUsername = String(username || '').trim().toLowerCase();
        return await this.get('SELECT * FROM admin_users WHERE username = ?', [normalizedUsername]);
    }

    async createAdmin(username, passwordHash, salt) {
        const normalizedUsername = String(username || '').trim().toLowerCase();
        const result = await this.run(
            'INSERT INTO admin_users (username, password_hash, salt) VALUES (?, ?, ?)',
            [normalizedUsername, passwordHash, salt]
        );
        return result.id;
    }

    async updateAdminLastLogin(adminId) {
        await this.run(
            'UPDATE admin_users SET last_login = CURRENT_TIMESTAMP WHERE id = ?',
            [adminId]
        );
    }

    normalizeShareType(shareType) {
        const rawType = String(shareType || '').toLowerCase();
        const allowed = ['screen', 'audio', 'video'];
        if (allowed.includes(rawType)) return rawType;

        const mappedToScreen = ['presentation', 'document', 'application', 'window', 'tab'];
        if (mappedToScreen.includes(rawType)) return 'screen';

        return 'screen';
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
                0 as content_shares,
                COUNT(DISTINCT pl.log_id) as performance_logs
            FROM sessions s
            LEFT JOIN performance_logs pl ON s.id = pl.session_id
            WHERE s.id = ?
            GROUP BY s.id
        `, [sessionId]);
        return stats;
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
                'SELECT id FROM attendance WHERE session_id = ? AND user_id = ? AND left_at IS NULL',
                [sessionId, userId]
            );
            
            if (attendance) {
                await this.run(
                    `
                        UPDATE attendance
                        SET
                            left_at = CURRENT_TIMESTAMP,
                            duration_minutes = MAX(
                                1,
                                CAST(ROUND((julianday(CURRENT_TIMESTAMP) - julianday(joined_at)) * 24 * 60) AS INTEGER)
                            )
                        WHERE id = ?
                    `,
                    [attendance.id]
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
                CASE
                    WHEN a.left_at IS NOT NULL THEN MAX(
                        1,
                        CAST(ROUND((julianday(a.left_at) - julianday(a.joined_at)) * 24 * 60) AS INTEGER)
                    )
                    WHEN a.duration_minutes IS NOT NULL THEN a.duration_minutes
                    ELSE NULL
                END AS duration_minutes
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
            const duration = record.duration_minutes ?? 'N/A';
            
            csv += `"${record.name}","${record.email}","${joinedAt}","${leftAt}","${duration}"\n`;
        });
        
        return csv;
    }

    // Enhanced performance logging with detailed metrics
    async logPerformance(sessionId, participantId, logType, message, metrics = {}) {
        try {
            if (!sessionId) {
                return;
            }

            const metricValue = (value, fallback = 0) => {
                if (value === null || value === undefined || value === '') return fallback;
                const num = Number(value);
                return Number.isFinite(num) ? num : fallback;
            };
            const fallbackThroughput = metrics.bandwidth_kbps !== undefined && metrics.bandwidth_kbps !== null
                ? Number(metrics.bandwidth_kbps) / 1000
                : null;

            // Ensure we have values even if metrics are empty
            const performanceData = {
                latency_ms: metricValue(metrics.latency_ms ?? metrics.latency ?? metrics.connection_time_ms, 0),
                throughput_mbps: metricValue(metrics.throughput_mbps ?? metrics.bandwidth ?? fallbackThroughput, 0),
                packet_loss_pct: metricValue(metrics.packet_loss_pct ?? metrics.packetLoss, 0),
                jitter_ms: metricValue(metrics.jitter_ms ?? metrics.jitter, 0),
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
                (session_id, participant_id, latency_ms, throughput_mbps, packet_loss_pct, jitter_ms, log_type, message, recorded_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [
                    sessionId,
                    participantId,
                    performanceData.latency_ms,
                    performanceData.throughput_mbps,
                    performanceData.packet_loss_pct,
                    performanceData.jitter_ms,
                    logType,
                    message
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
            
            return await this.all(query, params);
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

    async wipeOperationalData() {
        const clearedTables = {};

        await this.run('BEGIN TRANSACTION');
        try {
            clearedTables.attendance = (await this.run('DELETE FROM attendance')).changes;
            clearedTables.performance_logs = (await this.run('DELETE FROM performance_logs')).changes;
            clearedTables.user_feedback = (await this.run('DELETE FROM user_feedback')).changes;
            clearedTables.sessions = (await this.run('DELETE FROM sessions')).changes;
            clearedTables.users = (await this.run(`DELETE FROM users WHERE role != 'admin'`)).changes;
            await this.run(`DELETE FROM sqlite_sequence WHERE name IN ('attendance','performance_logs','user_feedback','sessions','users')`);
            await this.run('COMMIT');
            return clearedTables;
        } catch (error) {
            try {
                await this.run('ROLLBACK');
            } catch (_) {}
            throw error;
        }
    }

    async deleteTableContents(tableName) {
        const normalizedTable = String(tableName || '').trim().toLowerCase();
        const summary = {};

        await this.run('BEGIN TRANSACTION');
        try {
            switch (normalizedTable) {
                case 'attendance':
                case 'performance_logs':
                case 'user_feedback':
                case 'admin_users':
                    summary[normalizedTable] = (await this.run(`DELETE FROM ${normalizedTable}`)).changes;
                    break;
                case 'sessions':
                    summary.attendance = (await this.run('DELETE FROM attendance')).changes;
                    summary.performance_logs = (await this.run('DELETE FROM performance_logs')).changes;
                    summary.user_feedback = (await this.run('DELETE FROM user_feedback')).changes;
                    summary.sessions = (await this.run('DELETE FROM sessions')).changes;
                    break;
                case 'users':
                    summary.attendance = (await this.run('DELETE FROM attendance')).changes;
                    summary.performance_logs = (await this.run('DELETE FROM performance_logs')).changes;
                    summary.user_feedback = (await this.run('DELETE FROM user_feedback')).changes;
                    summary.sessions = (await this.run('DELETE FROM sessions')).changes;
                    summary.users = (await this.run('DELETE FROM users')).changes;
                    break;
                default:
                    throw new Error('Unsupported table for delete operation');
            }

            await this.run('COMMIT');
            return summary;
        } catch (error) {
            try {
                await this.run('ROLLBACK');
            } catch (_) {}
            throw error;
        }
    }

    async purgeExpiredData(retentionDays = 30) {
        const safeRetentionDays = Math.max(1, Number(retentionDays) || 30);
        const cutoffDate = new Date(Date.now() - safeRetentionDays * 24 * 60 * 60 * 1000).toISOString();
        const expiredFeedback = await this.all(
            'SELECT id, screenshot_path FROM user_feedback WHERE datetime(created_at) < datetime(?)',
            [cutoffDate]
        );

        const summary = {
            cutoffDate,
            retentionDays: safeRetentionDays,
            screenshotPaths: expiredFeedback
                .map((row) => row.screenshot_path)
                .filter(Boolean),
            deleted: {}
        };

        await this.run('BEGIN TRANSACTION');
        try {
            summary.deleted.performance_logs = (await this.run(
                'DELETE FROM performance_logs WHERE datetime(recorded_at) < datetime(?)',
                [cutoffDate]
            )).changes;
            summary.deleted.attendance = (await this.run(
                'DELETE FROM attendance WHERE datetime(joined_at) < datetime(?)',
                [cutoffDate]
            )).changes;
            summary.deleted.user_feedback = (await this.run(
                'DELETE FROM user_feedback WHERE datetime(created_at) < datetime(?)',
                [cutoffDate]
            )).changes;
            summary.deleted.sessions = (await this.run(
                'DELETE FROM sessions WHERE status = "ended" AND datetime(COALESCE(ended_at, created_at)) < datetime(?)',
                [cutoffDate]
            )).changes;
            summary.deleted.users = (await this.run(
                `DELETE FROM users
                 WHERE role != 'admin'
                   AND datetime(last_active) < datetime(?)
                   AND id NOT IN (SELECT presenter_id FROM sessions WHERE presenter_id IS NOT NULL)
                   AND id NOT IN (SELECT user_id FROM attendance)
                   AND id NOT IN (SELECT user_id FROM user_feedback)
                   AND id NOT IN (SELECT participant_id FROM performance_logs WHERE participant_id IS NOT NULL)`,
                [cutoffDate]
            )).changes;
            await this.run('COMMIT');
            return summary;
        } catch (error) {
            try {
                await this.run('ROLLBACK');
            } catch (_) {}
            throw error;
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
