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
let latestDeviceData = {
    '192.168.18.253': { 
        info: {},
        allUsers: [],
        adminUsers: [],
        attendanceLogs: [],
        deviceIP: '192.168.18.253',
        status: 'initializing' 
    },
    '192.168.18.252': { 
        info: {},
        allUsers: [],
        adminUsers: [],
        attendanceLogs: [],
        deviceIP: '192.168.18.252',
        status: 'initializing' 
    }
};

// Helper to create a Unique Key for every record
const createRecordSignature = (record) => {
    return `${record.deviceIP}_${record.deviceUserId}_${new Date(record.recordTime).getTime()}`;
};

// Load existing records
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

// Save Records
const saveRecords = () => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const filepath = path.join(dataDir, `attendance_${today}.json`);
        fs.writeFileSync(filepath, JSON.stringify(allAttendanceRecords, null, 2));
    } catch (error) {
        console.error('❌ Error saving records:', error);
    }
};

// Fetch device data - FIXED: Now returns allUsers and adminUsers
const fetchDeviceData = async (ip) => {
    const zkInstance = new ZKLib(ip, 4370, 5000, 4000);

    try {
        await zkInstance.createSocket();
        
        // Get ALL data from device
        const info = await zkInstance.getInfo();
        const users = await zkInstance.getUsers();
        const logs = await zkInstance.getAttendances();

        const allUsers = users?.data || [];
        const adminUsers = allUsers.filter(u => u.role === 14);
        const attendanceLogs = logs?.data || [];

        // Create user map for name lookup
        const userMap = {};
        allUsers.forEach(user => {
            userMap[user.userId] = user.name;
        });

        // Enhance logs with user names
        const enhancedLogs = attendanceLogs.map(log => ({
            ...log,
            name: userMap[log.deviceUserId] || 'Unknown',
            type: ip === '192.168.18.253' ? 'IN' : 'OUT',
            deviceIP: ip,
            recordTime: new Date(log.recordTime).toISOString() 
        }));

        await zkInstance.disconnect();
        
        return {
            info: info || {},
            allUsers,
            adminUsers,
            attendanceLogs: enhancedLogs,
            deviceIP: ip,
            status: 'online'
        };

    } catch (err) {
        console.log(`❌ Error from ${ip}:`, err.message);
        return {
            info: {},
            allUsers: [],
            adminUsers: [],
            attendanceLogs: [],
            deviceIP: ip,
            status: 'offline',
            error: err.message
        };
    }
};

// Main Logic - FIXED: Properly combine user data
const fetchAndSaveNewRecords = async () => {
    const devices = ['192.168.18.253', '192.168.18.252'];
    console.log('\n🔄 Checking for new attendance records...');

    try {
        const results = await Promise.allSettled(devices.map(ip => fetchDeviceData(ip)));
        
        let newRecordsCount = 0;
        const currentBatchData = {
            '192.168.18.253': {},
            '192.168.18.252': {},
            'combined': {}
        };

        // Combined data ke liye arrays
        const combinedLogs = [];
        const combinedAllUsers = [];
        const combinedAdminUsers = [];

        results.forEach((result, index) => {
            const ip = devices[index];
            
            if (result.status === 'fulfilled') {
                const deviceData = result.value;
                
                // Device-specific data
                currentBatchData[ip] = { 
                    ...deviceData,
                    attendanceLogs: deviceData.attendanceLogs,
                    allUsers: deviceData.allUsers,
                    adminUsers: deviceData.adminUsers,
                    info: deviceData.info
                };

                // Combined data collect karo
                combinedLogs.push(...deviceData.attendanceLogs);
                combinedAllUsers.push(...deviceData.allUsers);
                combinedAdminUsers.push(...deviceData.adminUsers);

                // Check for new attendance records
                deviceData.attendanceLogs.forEach(record => {
                    const sig = createRecordSignature(record);
                    if (!uniqueSignatures.has(sig)) {
                        uniqueSignatures.add(sig);
                        allAttendanceRecords.push(record);
                        newRecordsCount++;
                    }
                });

            } else {
                currentBatchData[ip] = {
                    info: {},
                    allUsers: [],
                    adminUsers: [],
                    attendanceLogs: [],
                    deviceIP: ip,
                    status: 'offline',
                    error: result.reason.message
                };
            }
        });

        // ✅ COMBINED VIEW DATA - FIXED: Proper user data
        currentBatchData['combined'] = {
            info: { 
                type: 'Combined View', 
                userCounts: combinedAllUsers.length,
                logCount: combinedLogs.length 
            },
            allUsers: [...new Map(combinedAllUsers.map(user => [user.userId, user])).values()], // Remove duplicates
            adminUsers: [...new Map(combinedAdminUsers.map(user => [user.userId, user])).values()], // Remove duplicates
            attendanceLogs: combinedLogs,
            deviceIP: 'Multiple Devices',
            status: 'online'
        };

        // Update global variable
        latestDeviceData = currentBatchData;

        if (newRecordsCount > 0) {
            saveRecords();
            console.log(`💾 Added & Saved ${newRecordsCount} NEW attendance records.`);
            console.log(`👥 Total users in combined view: ${combinedAllUsers.length}`);
            console.log(`👑 Admin users: ${combinedAdminUsers.length}`);
        } else {
            console.log(`⏭️ No new records found.`);
        }

        return {
            deviceData: latestDeviceData,
            combinedData: currentBatchData['combined'],
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
    try {
        const data = await fetchAndSaveNewRecords();
        res.render("index", {
            deviceData: latestDeviceData, 
            combinedData: latestDeviceData['combined'],
            newRecordsCount: data.newRecordsCount || 0,
            totalRecords: allAttendanceRecords.length,
            allAttendanceRecords: allAttendanceRecords
        });
    } catch (error) {
        res.render("index", {
            deviceData: latestDeviceData,
            combinedData: latestDeviceData['combined'] || {
                info: {},
                allUsers: [],
                adminUsers: [],
                attendanceLogs: [],
                deviceIP: 'Multiple Devices',
                status: 'online'
            },
            newRecordsCount: 0,
            totalRecords: allAttendanceRecords.length,
            allAttendanceRecords: allAttendanceRecords
        });
    }
});

app.get("/force-refresh", async (req, res) => {
    const data = await fetchAndSaveNewRecords();
    res.json(data);
});

// Main API endpoint
app.get("/api/data", async (req, res) => {
    try {
        const data = await fetchAndSaveNewRecords();
        res.json({
            deviceData: latestDeviceData,
            combinedData: latestDeviceData['combined'],
            newRecordsCount: data.newRecordsCount || 0,
            totalRecords: allAttendanceRecords.length,
            allAttendanceRecords: allAttendanceRecords
        });
    } catch (error) {
        res.json({
            deviceData: latestDeviceData,
            combinedData: latestDeviceData['combined'] || {
                info: {},
                allUsers: [],
                adminUsers: [],
                attendanceLogs: [],
                deviceIP: 'Multiple Devices',
                status: 'online'
            },
            newRecordsCount: 0,
            totalRecords: allAttendanceRecords.length,
            allAttendanceRecords: allAttendanceRecords
        });
    }
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
            filename: filename,
            newRecordsCount: data.newRecordsCount || 0,
            totalUsers: latestDeviceData['combined']?.allUsers?.length || 0
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
    res.json({ 
        status: 'running',
        timestamp: new Date().toISOString(),
        totalRecords: allAttendanceRecords.length,
        totalUsers: latestDeviceData['combined']?.allUsers?.length || 0,
        adminUsers: latestDeviceData['combined']?.adminUsers?.length || 0
    });
});

app.listen(PORT, () => {
    console.log(`\n🎉 Server: http://localhost:${PORT}`);
    console.log(`📁 Data directory: ${dataDir}`);
    console.log(`⏰ Auto fetch: Every 30 minutes`);
});