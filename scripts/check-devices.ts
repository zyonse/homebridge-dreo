import DreoAPI from '../src/DreoAPI';
import * as fs from 'fs';
import * as path from 'path';

// Load .env manually if it exists
try {
  const envPath = path.resolve(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        let val = match[2].trim();
        // Remove quotes if present
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.substring(1, val.length - 1);
        }
        process.env[key] = val;
      }
    }
  }
} catch (err) {
  // Ignore errors loading .env
}

const email = process.env.DREO_EMAIL;
const password = process.env.DREO_PASSWORD;

if (!email || !password) {
  console.error('Error: Please set DREO_EMAIL and DREO_PASSWORD environment variables.');
  console.error('You can also create a .env file in the root of this project with:');
  console.error('DREO_EMAIL=your_email@example.com');
  console.error('DREO_PASSWORD=your_password');
  process.exit(1);
}

// Mock logger and platform
const mockLogger: any = {
  info: (msg, ...args) => console.log(`[INFO] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
  debug: (msg, ...args) => console.log(`[DEBUG] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[WARN] ${msg}`, ...args),
};

const mockPlatform: any = {
  log: mockLogger,
  config: {
    options: {
      email,
      password,
    },
  },
};

async function run() {
  console.log('Initializing Dreo API...');
  const api = new DreoAPI(mockPlatform);

  console.log('Authenticating...');
  const auth = await api.authenticate();
  if (!auth) {
    console.error('Authentication failed.');
    process.exit(1);
  }

  console.log('Authentication successful!');
  console.log(`Country Code: ${auth.countryCode}`);
  console.log(`Region: ${auth.region}`);

  if (auth.region === 'EU') {
    console.log('Switching to EU server...');
    api.server = 'eu';
    await api.authenticate();
  }

  console.log('Fetching devices...');
  const devices = await api.getDevices();
  if (!devices) {
    console.error('Failed to retrieve devices.');
    process.exit(1);
  }

  console.log(`Found ${devices.length} devices:`);
  for (const device of devices) {
    console.log('\n=========================================');
    console.log(`Device Name:  ${device.deviceName}`);
    console.log(`Model:        ${device.model}`);
    console.log(`Product Name: ${device.productName}`);
    console.log(`Serial No:    ${device.sn}`);
    console.log(`Controls Conf:`, JSON.stringify(device.controlsConf, null, 2));

    console.log('Fetching device state...');
    const state = await api.getState(device.sn);
    console.log('Device State:', JSON.stringify(state, null, 2));
  }

  console.log('\n=========================================');
  console.log('Starting WebSocket connection to check messages...');
  await api.startWebSocket();

  // Listen for messages for 5 seconds
  api.addEventListener('message', (message: any) => {
    try {
      const data = JSON.parse(message.data);
      console.log('\n[WS Message Received]:', JSON.stringify(data, null, 2));
    } catch (e) {
      console.log('\n[WS Raw Message Received]:', message.data);
    }
  });

  console.log('Listening for WebSocket messages for 10 seconds...');
  await new Promise((resolve) => setTimeout(resolve, 10000));
  
  console.log('Done checking. Exiting.');
  process.exit(0);
}

run().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
