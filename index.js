import express from "express";
import ZKLib from "node-zklib";

const app = express();
const PORT = 5000;

app.set("view engine", "ejs");
app.use(express.static("public"));

// Function to fetch data from a single device
const fetchDeviceData = async (ip) => {
    const zkInstance = new ZKLib(ip, 4370, 10000, 4000);

    try {
        await zkInstance.createSocket();

        const info = await zkInstance.getInfo();
        const users = await zkInstance.getUsers();
        const logs = await zkInstance.getAttendances();

        console.log(`Data from ${ip}:`, {
            userCount: users?.data?.length || 0,
            logCount: logs?.data?.length || 0
        });

        const allUsers = users?.data || [];
        const adminUsers = allUsers.filter(u => u.role === 14);
        const attendanceLogs = logs?.data || [];

        // Create user map for name lookup
        const userMap = {};
        allUsers.forEach(user => {
            userMap[user.userId] = user.name;
        });

        // Enhance logs with user names and type based on IP
        const enhancedLogs = attendanceLogs.map(log => ({
            ...log,
            name: userMap[log.deviceUserId] || 'Unknown',
            type: ip === '192.168.18.253' ? 'IN' : 'OUT',
            deviceIP: ip
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
        console.log(`Error fetching from ${ip}:`, err.message);
        return {
            error: err.message,
            deviceIP: ip,
            status: 'offline',
            info: {},
            allUsers: [],
            adminUsers: [],
            attendanceLogs: []
        };
    }
};

// Fetch data from both devices
const fetchAllDeviceData = async () => {
    const devices = [
        '192.168.18.253',
        '192.168.18.252'
    ];

    try {
        const devicePromises = devices.map(ip => fetchDeviceData(ip));
        const results = await Promise.allSettled(devicePromises);

        const deviceData = {};
        const combinedData = {
            allUsers: [],
            adminUsers: [],
            attendanceLogs: [],
            info: {}
        };

        results.forEach((result, index) => {
            const ip = devices[index];
            if (result.status === 'fulfilled') {
                deviceData[ip] = result.value;
                
                // Combine data
                combinedData.allUsers = [...combinedData.allUsers, ...result.value.allUsers];
                combinedData.adminUsers = [...combinedData.adminUsers, ...result.value.adminUsers];
                combinedData.attendanceLogs = [...combinedData.attendanceLogs, ...result.value.attendanceLogs];
                
                // Use info from first successful device
                if (Object.keys(combinedData.info).length === 0 && result.value.info) {
                    combinedData.info = result.value.info;
                }
            } else {
                deviceData[ip] = {
                    error: result.reason.message,
                    deviceIP: ip,
                    status: 'offline',
                    info: {},
                    allUsers: [],
                    adminUsers: [],
                    attendanceLogs: []
                };
            }
        });

        // Remove duplicate users based on userId
        combinedData.allUsers = combinedData.allUsers.filter((user, index, self) => 
            index === self.findIndex(u => u.userId === user.userId)
        );
        
        combinedData.adminUsers = combinedData.adminUsers.filter((user, index, self) => 
            index === self.findIndex(u => u.userId === user.userId)
        );

        return {
            deviceData,
            combinedData
        };

    } catch (err) {
        console.log("Error in fetchAllDeviceData:", err);
        return { 
            error: err.message,
            deviceData: {},
            combinedData: {
                allUsers: [],
                adminUsers: [],
                attendanceLogs: [],
                info: {}
            }
        };
    }
};

app.get("/", async (req, res) => {
    try {
        const data = await fetchAllDeviceData();
        res.render("index", data);
    } catch (error) {
        console.log("Error in route:", error);
        res.render("index", {
            deviceData: {},
            combinedData: {
                allUsers: [],
                adminUsers: [],
                attendanceLogs: [],
                info: {}
            }
        });
    }
});

app.get("/api/data", async (req, res) => {
    try {
        const data = await fetchAllDeviceData();
        res.json(data);
    } catch (error) {
        res.json({
            error: error.message,
            deviceData: {},
            combinedData: {
                allUsers: [],
                adminUsers: [],
                attendanceLogs: [],
                info: {}
            }
        });
    }
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));