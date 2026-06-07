import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import User from '../models/User.js';

// Setup __dirname for ES modules to load the sibling .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env configuration
dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/excel_login_db';

const askQuestion = (query) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans.trim());
  }));
};

const signup = async () => {
  let email = process.argv[2];
  let password = process.argv[3];

  // If arguments are missing, switch to interactive prompt mode
  if (!email || !password) {
    console.log('\n📝 Welcome to User Signup Wizard');
    console.log('--------------------------------');
    if (!email) {
      email = await askQuestion('📧 Enter Email Address: ');
    }
    if (!password) {
      password = await askQuestion('🔑 Enter Password: ');
    }
    console.log('--------------------------------\n');
  }

  if (!email || !password) {
    console.error('❌ Error: Both Email and Password are required.');
    process.exit(1);
  }

  // Simple email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    console.error('❌ Error: Invalid email format.');
    process.exit(1);
  }

  if (password.length < 6) {
    console.error('❌ Error: Password must be at least 6 characters long.');
    process.exit(1);
  }

  try {
    console.log('Connecting to MongoDB database...');
    await mongoose.connect(MONGODB_URI);
    console.log('Successfully connected.');

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      console.error(`❌ Error: User with email ${email} already exists.`);
      await mongoose.connection.close();
      process.exit(1);
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Save user to the DB
    const newUser = new User({
      email,
      password: hashedPassword
    });

    await newUser.save();
    console.log(`\n🎉 Success: User registered successfully!`);
    console.log(`📧 Email: ${email}`);
    console.log(`🔑 ID: ${newUser._id}\n`);

  } catch (err) {
    console.error('❌ Error executing signup script:', err.message);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed.');
  }
};

signup();
