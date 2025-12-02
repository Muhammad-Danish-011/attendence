import express from "express";
import ZKLib from "node-zklib";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cron from 'node-cron';
import axios from 'axios'; // You need to install axios: npm install axios

const app = express();
const PORT = 3000;

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

// Save Records locally
const saveRecords = () => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const filepath = path.join(dataDir, `attendance_${today}.json`);
        fs.writeFileSync(filepath, JSON.stringify(allAttendanceRecords, null, 2));
        console.log(`💾 Saved ${allAttendanceRecords.length} records locally to ${filepath}`);
    } catch (error) {
        console.error('❌ Error saving records locally:', error);
    }
};

// Fetch device data
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

// Convert to C# API format
const convertToCSharpFormat = (logs) => {
    return logs.map(log => ({
        UserSN: log.userSn || 0,
        DeviceUserID: log.deviceUserId?.toString() || '',
        UserName: log.name || 'Unknown',
        RecordTime: new Date(log.recordTime),
        DeviceIP: log.deviceIP || '',
        Type: log.type || 'UNKNOWN'
    }));
};

// Send data to C# API
const sendToCSharpAPI = async (records) => {
    if (!records || records.length === 0) {
        console.log('⚠️ No records to send to C# API');
        return { success: false, message: 'No records to send' };
    }

    try {
        console.log(`📤 Sending ${records.length} records to C# API...`);
        
        const convertedRecords = convertToCSharpFormat(records);
        
        // Send to your C# API endpoint
        const response = await axios.post('https://api20230805195433.azurewebsites.net/api/attendance/upload-file', 
            convertedRecords,
            {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log(`✅ Successfully sent to C# API:`, response.data);
        return {
            success: true,
            data: response.data,
            recordsSent: records.length
        };
        
    } catch (error) {
        console.error('❌ Error sending to C# API:', error.message);
        return {
            success: false,
            error: error.message,
            recordsSent: 0
        };
    }
};

// Main Logic - Fetch data and send to C# API
const fetchAndSendToAPI = async () => {
    const devices = ['192.168.18.253', '192.168.18.252'];
    console.log('\n🔄 Fetching data from devices to send to C# API...');

    try {
        const results = await Promise.allSettled(devices.map(ip => fetchDeviceData(ip)));
        
        let newRecordsCount = 0;
        const currentBatchData = {
            '192.168.18.253': {},
            '192.168.18.252': {},
            'combined': {}
        };

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

                // Combine data
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

        // ✅ COMBINED VIEW DATA
        currentBatchData['combined'] = {
            info: { 
                type: 'Combined View', 
                userCounts: combinedAllUsers.length,
                logCount: combinedLogs.length 
            },
            allUsers: [...new Map(combinedAllUsers.map(user => [user.userId, user])).values()],
            adminUsers: [...new Map(combinedAdminUsers.map(user => [user.userId, user])).values()],
            attendanceLogs: combinedLogs,
            deviceIP: 'Multiple Devices',
            status: 'online'
        };

        // Update global variable
        latestDeviceData = currentBatchData;

        if (newRecordsCount > 0) {
            // Save locally first
            saveRecords();
            
            // Send new records to C# API
            const newRecords = allAttendanceRecords.slice(-newRecordsCount);
            const apiResult = await sendToCSharpAPI(newRecords);
            
            console.log(`💾 Added & Saved ${newRecordsCount} NEW attendance records locally.`);
            console.log(`📤 API Send Result: ${apiResult.success ? 'Success' : 'Failed'}`);
            
            if (apiResult.success) {
                console.log(`✅ Sent ${newRecordsCount} records to C# API successfully`);
            } else {
                console.log(`❌ Failed to send to C# API: ${apiResult.error}`);
            }
        } else {
            console.log(`⏭️ No new records found. Nothing to send to API.`);
        }

        return {
            deviceData: latestDeviceData,
            combinedData: currentBatchData['combined'],
            newRecordsCount,
            totalRecords: allAttendanceRecords.length,
            apiSent: newRecordsCount > 0
        };

    } catch (err) {
        console.log("❌ Error:", err.message);
        return { error: err.message };
    }
};

// ==================== CRON JOB - Every 30 minutes ====================
// This will run automatically every 30 minutes
cron.schedule('*/30 * * * *', async () => {
    console.log(`\n⏰ [SCHEDULED JOB] Running at: ${new Date().toLocaleString()}`);
    console.log('📡 Fetching data from devices and sending to C# API...');
    
    const result = await fetchAndSendToAPI();
    
    if (result.error) {
        console.log(`❌ Scheduled job failed: ${result.error}`);
    } else {
        console.log(`✅ Scheduled job completed. New records: ${result.newRecordsCount || 0}`);
    }
    
    console.log('⏳ Next run in 30 minutes...\n');
});

// ==================== MANUAL TRIGGER ENDPOINTS ====================

// Manual trigger endpoint
app.get("/api/trigger-sync", async (req, res) => {
    console.log('🔔 Manual sync triggered via API');
    const result = await fetchAndSendToAPI();
    res.json({
        success: !result.error,
        message: result.error ? 'Sync failed' : 'Sync completed',
        data: result
    });
});

// Force immediate sync
app.get("/api/force-sync", async (req, res) => {
    console.log('⚡ Force sync triggered');
    const result = await fetchAndSendToAPI();
    res.json({
        success: !result.error,
        message: result.error ? 'Force sync failed' : 'Force sync completed',
        data: result,
        timestamp: new Date().toISOString()
    });
});

// ==================== STARTUP ====================
console.log('🚀 Starting ZKTeco Device Sync Scheduler...');
console.log('📡 This app will automatically sync with devices every 30 minutes');
console.log('🌐 And send data to C# API at: https://api20230805195433.azurewebsites.net/api/attendance/upload-file');

loadExistingRecords();

// Initial sync after 2 seconds
setTimeout(async () => {
    console.log('\n🔔 Performing initial sync...');
    const result = await fetchAndSendToAPI();
    
    if (result.error) {
        console.log('❌ Initial sync failed:', result.error);
    } else {
        console.log('✅ Initial sync completed');
        console.log(`📊 Total records: ${result.totalRecords || 0}`);
        console.log(`🔄 Next auto-sync in 30 minutes`);
    }
}, 2000);

// ==================== DASHBOARD ROUTES ====================

// Routes
app.get("/", async (req, res) => {
    try {
        const data = await fetchAndSendToAPI();
        res.render("index", {
            deviceData: latestDeviceData, 
            combinedData: latestDeviceData['combined'],
            newRecordsCount: data.newRecordsCount || 0,
            totalRecords: allAttendanceRecords.length,
            allAttendanceRecords: allAttendanceRecords,
            lastSync: new Date().toLocaleString(),
            nextSync: new Date(Date.now() + 30 * 60 * 1000).toLocaleString()
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
            allAttendanceRecords: allAttendanceRecords,
            lastSync: 'Never',
            nextSync: new Date(Date.now() + 30 * 60 * 1000).toLocaleString()
        });
    }
});

app.get("/force-refresh", async (req, res) => {
    const data = await fetchAndSendToAPI();
    res.json(data);
});

// Main API endpoint
app.get("/api/data", async (req, res) => {
    try {
        const data = await fetchAndSendToAPI();
        res.json({
            deviceData: latestDeviceData,
            combinedData: latestDeviceData['combined'],
            newRecordsCount: data.newRecordsCount || 0,
            totalRecords: allAttendanceRecords.length,
            allAttendanceRecords: allAttendanceRecords,
            lastSyncTime: new Date().toISOString(),
            nextSyncTime: new Date(Date.now() + 30 * 60 * 1000).toISOString()
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
            allAttendanceRecords: allAttendanceRecords,
            lastSyncTime: null,
            nextSyncTime: new Date(Date.now() + 30 * 60 * 1000).toISOString()
        });
    }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
    const now = new Date();
    const nextRun = new Date(now.getTime() + 30 * 60 * 1000);
    
    res.json({ 
        status: 'running',
        timestamp: now.toISOString(),
        scheduler: {
            enabled: true,
            interval: 'Every 30 minutes',
            lastRun: latestDeviceData['192.168.18.253']?.status === 'initializing' ? 'Never' : 'Recently',
            nextRun: nextRun.toISOString()
        },
        devices: {
            device1: latestDeviceData['192.168.18.253']?.status || 'unknown',
            device2: latestDeviceData['192.168.18.252']?.status || 'unknown'
        },
        dataStats: {
            totalRecords: allAttendanceRecords.length,
            uniqueSignatures: uniqueSignatures.size
        },
        csharpApi: {
            endpoint: 'https://api20230805195433.azurewebsites.net/api/attendance/upload-file',
            status: 'Active'
        }
    });
});

// Status endpoint
app.get("/api/status", (req, res) => {
    res.json({
        scheduler: {
            active: true,
            description: 'Auto-sync every 30 minutes',
            nextExecution: new Date(Date.now() + 30 * 60 * 1000).toLocaleString()
        },
        devices: [
            {
                ip: '192.168.18.253',
                status: latestDeviceData['192.168.18.253']?.status || 'unknown',
                lastCheck: new Date().toLocaleString()
            },
            {
                ip: '192.168.18.252',
                status: latestDeviceData['192.168.18.252']?.status || 'unknown',
                lastCheck: new Date().toLocaleString()
            }
        ],
        data: {
            localRecords: allAttendanceRecords.length,
            lastLocalSave: new Date().toLocaleString()
        },
        apiIntegration: {
            csharpApi: 'https://api20230805195433.azurewebsites.net/api/attendance/upload-file',
            method: 'POST',
            format: 'JSON array of AttendanceRecordDto'
        }
    });
});

app.listen(PORT, () => {
    console.log(`\n🎉 Scheduler Dashboard: http://localhost:${PORT}`);
    console.log(`📁 Local Data Directory: ${dataDir}`);
    console.log(`⏰ Auto Sync: Every 30 minutes`);
    console.log(`📤 Target API: https://api20230805195433.azurewebsites.net/api/attendance/upload-file`);
    console.log(`\n📋 Manual Trigger Endpoints:`);
    console.log(`   http://localhost:${PORT}/api/trigger-sync - Manual sync`);
    console.log(`   http://localhost:${PORT}/api/force-sync - Force sync`);
    console.log(`   http://localhost:${PORT}/api/status - Check status`);
    console.log(`\n⏳ First auto-sync in 30 minutes...`);
});