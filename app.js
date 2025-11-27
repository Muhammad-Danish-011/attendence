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

// Global array to store ALL attendance records
let allAttendanceRecords = [];

// Load existing records from today's file
const loadExistingRecords = () => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const filepath = path.join(dataDir, `attendance_${today}.json`);
        
        if (fs.existsSync(filepath)) {
            const fileContent = fs.readFileSync(filepath, 'utf8');
            const data = JSON.parse(fileContent);
            
            // Extract ALL attendance records from file
            allAttendanceRecords = [];
            if (Array.isArray(data)) {
                data.forEach(entry => {
                    if (entry.attendanceLogs && Array.isArray(entry.attendanceLogs)) {
                        allAttendanceRecords.push(...entry.attendanceLogs);
                    }
                });
            }
            
            console.log(`📁 Loaded ${allAttendanceRecords.length} existing records`);
        } else {
            console.log('📄 Starting fresh - no existing file');
            allAttendanceRecords = [];
        }
    } catch (error) {
        console.log('❌ Error loading records:', error.message);
        allAttendanceRecords = [];
    }
};

// Check if record already exists
const isRecordExists = (record) => {
    return allAttendanceRecords.some(existing => 
        existing.userSn === record.userSn && 
        existing.recordTime === record.recordTime &&
        existing.deviceIP === record.deviceIP
    );
};

// Get only NEW records
const getNewRecords = (currentRecords) => {
    const newRecords = currentRecords.filter(record => !isRecordExists(record));
    console.log(`🔄 New records: ${newRecords.length} / ${currentRecords.length}`);
    return newRecords;
};

// Save ONLY NEW records to file
const saveNewRecords = (newRecords) => {
    if (newRecords.length === 0) {
        console.log('⏭️ No new records to save');
        return;
    }

    try {
        const today = new Date().toISOString().split('T')[0];
        const filepath = path.join(dataDir, `attendance_${today}.json`);
        
        let fileData = [];
        if (fs.existsSync(filepath)) {
            try {
                const fileContent = fs.readFileSync(filepath, 'utf8');
                fileData = JSON.parse(fileContent);
            } catch (err) {
                fileData = [];
            }
        }

        // Create simple entry with only new records
        const newEntry = {
            timestamp: new Date().toISOString(),
            newRecordsCount: newRecords.length,
            attendanceLogs: newRecords
        };

        fileData.push(newEntry);
        fs.writeFileSync(filepath, JSON.stringify(fileData, null, 2));
        
        // Update global array
        allAttendanceRecords.push(...newRecords);
        
        console.log(`💾 Saved ${newRecords.length} new records | Total: ${allAttendanceRecords.length}`);
        
    } catch (error) {
        console.error('❌ Error saving records:', error);
    }
};

// Fetch device data
const fetchDeviceData = async (ip) => {
    const zkInstance = new ZKLib(ip, 4370, 10000, 4000);

    try {
        await zkInstance.createSocket();

        const users = await zkInstance.getUsers();
        const logs = await zkInstance.getAttendances();

        const allUsers = users?.data || [];
        const attendanceLogs = logs?.data || [];

        // Create user map
        const userMap = {};
        allUsers.forEach(user => {
            userMap[user.userId] = user.name;
        });

        // Enhance logs
        const enhancedLogs = attendanceLogs.map(log => ({
            ...log,
            name: userMap[log.deviceUserId] || 'Unknown',
            type: ip === '192.168.18.253' ? 'IN' : 'OUT',
            deviceIP: ip
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

// Main function - ONLY SAVES NEW RECORDS
const fetchAndSaveNewRecords = async () => {
    const devices = ['192.168.18.253', '192.168.18.252'];

    console.log('\n🔄 Checking for new attendance records...');

    try {
        const results = await Promise.allSettled(devices.map(ip => fetchDeviceData(ip)));
        
        let allCurrentRecords = [];
        const deviceData = {};

        results.forEach((result, index) => {
            const ip = devices[index];
            if (result.status === 'fulfilled') {
                deviceData[ip] = result.value;
                allCurrentRecords.push(...result.value.attendanceLogs);
            } else {
                deviceData[ip] = {
                    attendanceLogs: [],
                    status: 'offline',
                    error: result.reason.message
                };
            }
        });

        // Get ONLY NEW records
        const newRecords = getNewRecords(allCurrentRecords);
        
        // Save ONLY if new records exist
        if (newRecords.length > 0) {
            saveNewRecords(newRecords);
            console.log(`✅ ${newRecords.length} NEW records saved`);
        } else {
            console.log(`⏭️ No new records found`);
        }

        return {
            deviceData,
            newRecordsCount: newRecords.length,
            totalRecords: allAttendanceRecords.length,
            currentRecords: allCurrentRecords.length
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

// Load existing records on startup
console.log('🚀 Starting server...');
loadExistingRecords();

// Initial fetch
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
            ...data,
            allAttendanceRecords: allAttendanceRecords
        });
    } catch (error) {
        res.render("index", {
            deviceData: {},
            newRecordsCount: 0,
            totalRecords: allAttendanceRecords.length,
            error: error.message
        });
    }
});

app.get("/api/data", async (req, res) => {
    try {
        const data = await fetchAndSaveNewRecords();
        res.json(data);
    } catch (error) {
        res.json({ error: error.message });
    }
});

app.get("/api/records", (req, res) => {
    res.json({
        totalRecords: allAttendanceRecords.length,
        records: allAttendanceRecords
    });
});

app.get("/api/health", (req, res) => {
    res.json({ 
        status: 'running',
        totalSavedRecords: allAttendanceRecords.length,
        lastCheck: new Date().toLocaleString()
    });
});

app.listen(PORT, () => {
    console.log(`\n🎉 Server: http://localhost:${PORT}`);
    console.log(`⏰ Auto check: Every 30 minutes`);
    console.log(`💾 Only NEW records are saved`);
    console.log(`📊 Current records: ${allAttendanceRecords.length}`);
});