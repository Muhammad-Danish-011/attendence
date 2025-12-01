import express from "express";
import ZKLib from "node-zklib";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cron from 'node-cron';

const app = express();
const PORT = 5000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

app.set("view engine", "ejs");
app.use(express.static("public"));

// Global State
let allAttendanceRecords = [];
let uniqueSignatures = new Set(); 

// FIX: Ye variable frontend ko crash hone se bachayega
let latestDeviceData = {
    '192.168.18.253': { status: 'initializing', attendanceLogs: [] },
    '192.168.18.252': { status: 'initializing', attendanceLogs: [] }
};

// 1. Helper to create a Unique Key for every record
const createRecordSignature = (record) => {
    return `${record.deviceIP}_${record.deviceUserId}_${new Date(record.recordTime).getTime()}`;
};

// 2. Load existing records
const loadExistingRecords = () => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const filepath = path.join(dataDir, `attendance_${today}.json`);
        
        allAttendanceRecords = [];
        uniqueSignatures.clear();

        if (fs.existsSync(filepath)) {
            const fileContent = fs.readFileSync(filepath, 'utf8');
            const data = JSON.parse(fileContent);
            
            if (Array.isArray(data)) {
                data.forEach(item => {
                    if (item.deviceUserId && item.recordTime) {
                        const sig = createRecordSignature(item);
                        if (!uniqueSignatures.has(sig)) {
                            uniqueSignatures.add(sig);
                            allAttendanceRecords.push(item);
                        }
                    }
                });
            }
            console.log(`📁 Loaded ${allAttendanceRecords.length} unique records`);
        }
    } catch (error) {
        console.log('❌ Error loading records:', error.message);
        allAttendanceRecords = [];
        uniqueSignatures.clear();
    }
};

// 3. Save Records
const saveRecords = () => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const filepath = path.join(dataDir, `attendance_${today}.json`);
        fs.writeFileSync(filepath, JSON.stringify(allAttendanceRecords, null, 2));
    } catch (error) {
        console.error('❌ Error saving records:', error);
    }
};

// 4. Fetch device data
const fetchDeviceData = async (ip) => {
    const zkInstance = new ZKLib(ip, 4370, 5000, 4000);

    try {
        await zkInstance.createSocket();
        const users = await zkInstance.getUsers();
        const logs = await zkInstance.getAttendances();

        const allUsers = users?.data || [];
        const attendanceLogs = logs?.data || [];

        const userMap = {};
        allUsers.forEach(user => {
            userMap[user.userId] = user.name;
        });

        const enhancedLogs = attendanceLogs.map(log => ({
            ...log,
            name: userMap[log.deviceUserId] || 'Unknown',
            type: ip === '192.168.18.253' ? 'IN' : 'OUT',
            deviceIP: ip,
            recordTime: new Date(log.recordTime).toISOString() 
        }));

        await zkInstance.disconnect();
        
        return {
            attendanceLogs: enhancedLogs,
            status: 'online'
        };

    } catch (err) {
        console.log(`❌ Error from ${ip}:`, err.message);
        return {
            attendanceLogs: [],
            status: 'offline',
            error: err.message
        };
    }
};

// 5. Main Logic
const fetchAndSaveNewRecords = async () => {
    const devices = ['192.168.18.253', '192.168.18.252'];
    console.log('\n🔄 Checking for new attendance records...');

    try {
        const results = await Promise.allSettled(devices.map(ip => fetchDeviceData(ip)));
        
        let newRecordsCount = 0;
        const currentBatchData = {
            '192.168.18.253': {},
            '192.168.18.252': {},
            'combined': {}  // ✅ Combined view ke liye
        };

        // Combined data ke liye arrays
        const combinedLogs = [];
        const combinedUsers = [];
        const combinedAdminUsers = [];

        results.forEach((result, index) => {
            const ip = devices[index];
            
            if (result.status === 'fulfilled') {
                const logs = result.value.attendanceLogs;
                
                // Device-specific data
                currentBatchData[ip] = { 
                    ...result.value, 
                    attendanceLogs: logs,
                    allUsers: result.value.allUsers || [],
                    adminUsers: result.value.adminUsers || [],
                    info: result.value.info || {}
                };

                // Combined data collect karo
                combinedLogs.push(...logs);
                if (result.value.allUsers) combinedUsers.push(...result.value.allUsers);
                if (result.value.adminUsers) combinedAdminUsers.push(...result.value.adminUsers);

                logs.forEach(record => {
                    const sig = createRecordSignature(record);
                    if (!uniqueSignatures.has(sig)) {
                        uniqueSignatures.add(sig);
                        allAttendanceRecords.push(record);
                        newRecordsCount++;
                    }
                });

            } else {
                currentBatchData[ip] = {
                    attendanceLogs: [],
                    status: 'offline',
                    error: result.reason.message
                };
            }
        });

        // ✅ COMBINED VIEW DATA
        currentBatchData['combined'] = {
            attendanceLogs: combinedLogs,
            allUsers: [...new Map(combinedUsers.map(user => [user.userId, user])).values()], // Remove duplicates
            adminUsers: [...new Map(combinedAdminUsers.map(user => [user.userId, user])).values()],
            info: { type: 'Combined View', userCounts: combinedUsers.length },
            status: 'online'
        };

        // Update global variable
        latestDeviceData = currentBatchData;

        if (newRecordsCount > 0) {
            saveRecords();
            console.log(`💾 Added & Saved ${newRecordsCount} NEW records.`);
        } else {
            console.log(`⏭️ No new records found.`);
        }

        return {
            deviceData: latestDeviceData,
            combinedData: currentBatchData['combined'], // ✅ Ye important hai
            newRecordsCount,
            totalRecords: allAttendanceRecords.length
        };

    } catch (err) {
        console.log("❌ Error:", err.message);
        return { error: err.message };
    }
};

// Auto fetch every 30 minutes
cron.schedule('*/30 * * * *', async () => {
    console.log(`\n⏰ Scheduled check: ${new Date().toLocaleString()}`);
    await fetchAndSaveNewRecords();
});

// Startup
console.log('🚀 Starting server...');
loadExistingRecords();

setTimeout(() => {
    fetchAndSaveNewRecords().then(() => {
        console.log('✅ Initial check completed');
    });
}, 2000);

// Routes
app.get("/", async (req, res) => {
    res.render("index", {
        // FIX: Ensure deviceData is never undefined
        deviceData: latestDeviceData || {}, 
        newRecordsCount: 0,
        totalRecords: allAttendanceRecords.length,
        allAttendanceRecords: allAttendanceRecords
    });
});

app.get("/force-refresh", async (req, res) => {
    const data = await fetchAndSaveNewRecords();
    res.json(data);
});

// FIX: Updated API route to send structure expected by frontend
// FIX: API route update karo
app.get("/api/data", (req, res) => {
    res.json({
        deviceData: latestDeviceData,
        combinedData: latestDeviceData['combined'] || {
            attendanceLogs: [],
            allUsers: [],
            adminUsers: [],
            info: {},
            status: 'online'
        },
        totalRecords: allAttendanceRecords.length,
        allAttendanceRecords: allAttendanceRecords
    });
});
// File Management API Endpoints
app.get("/api/files", (req, res) => {
    try {
        const files = fs.readdirSync(dataDir)
            .filter(file => file.endsWith('.json'))
            .map(file => {
                const filePath = path.join(dataDir, file);
                const stats = fs.statSync(filePath);
                return {
                    filename: file,
                    path: filePath,
                    size: stats.size,
                    created: stats.birthtime,
                    modified: stats.mtime
                };
            })
            .sort((a, b) => new Date(b.created) - new Date(a.created));
        
        res.json(files);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API endpoint to get specific file content
app.get("/api/files/:filename", (req, res) => {
    try {
        const filename = req.params.filename;
        if (filename.includes('..') || !filename.endsWith('.json')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        
        const filePath = path.join(dataDir, filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        const fileContent = fs.readFileSync(filePath, 'utf8');
        res.json(JSON.parse(fileContent));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API endpoint to delete a file
app.delete("/api/files/:filename", (req, res) => {
    try {
        const filename = req.params.filename;
        if (filename.includes('..') || !filename.endsWith('.json')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        
        const filePath = path.join(dataDir, filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        fs.unlinkSync(filePath);
        res.json({ message: 'File deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Manual save endpoint
app.post("/api/save", async (req, res) => {
    try {
        const data = await fetchAndSaveNewRecords();
        const today = new Date().toISOString().split('T')[0];
        const filename = `attendance_${today}.json`;
        
        res.json({ 
            message: 'Data saved successfully', 
            filename: filename 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


app.listen(PORT, () => {
    console.log(`\n🎉 Server: http://localhost:${PORT}`);
});