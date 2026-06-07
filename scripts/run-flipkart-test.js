import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { runFlipkartAutomation } from '../playwright/automation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/excel_login_db';

async function test() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB. Running Flipkart automation for temp_emails.xlsx...');
    
    // Trigger the automation for temp_emails.xlsx uploaded by admin user (6a2454960e8999ac50fa1755)
    await runFlipkartAutomation('temp_emails.xlsx', '6a2454960e8999ac50fa1755');
  } catch (err) {
    console.error('Test error:', err.message);
  } finally {
    await mongoose.connection.close();
    console.log('DB connection closed.');
  }
}

test();
