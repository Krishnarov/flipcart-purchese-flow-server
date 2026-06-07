import * as xlsx from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function verify() {
  console.log('--- STARTING VERIFICATION FLOW ---');
  
  // 1. Create a dummy Excel sheet in memory containing an Email column
  const sampleData = [
    { Name: 'John Doe', Email: 'john.doe@company.com', Department: 'Engineering' },
    { Name: 'Jane Smith', 'Email Address': 'jane.smith@design.com', Department: 'Design' }, // check fallback header
    { Name: 'Alice Johnson', 'Email ID': 'alice.j@sales.com', Department: 'Sales' }, // check fallback header
    { Name: 'Bob Brown', mail: 'bob.brown@marketing.com', Department: 'Marketing' } // check fallback header
  ];
  
  const worksheet = xlsx.utils.json_to_sheet(sampleData);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Emails');
  
  const filePath = path.join(__dirname, 'temp_emails.xlsx');
  xlsx.writeFile(workbook, filePath);
  console.log('✅ Temporary sample Excel file created.');

  try {
    // 2. Perform Login
    console.log('🔑 Attempting login...');
    const loginRes = await fetch('http://localhost:5000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@gmail.com', password: '1234567890' }) // use user registered earlier
    });
    
    const loginData = await loginRes.json();
    if (!loginRes.ok) {
      throw new Error(`Login failed: ${loginData.message}`);
    }
    
    console.log('✅ Login successful! Token obtained.');
    const token = loginData.token;

    // 3. Upload File
    console.log('📤 Uploading Excel file to backend...');
    
    // Construct multipart form data body manually
    const fileBuffer = fs.readFileSync(filePath);
    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="temp_emails.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    
    const bodyBuffer = Buffer.concat([
      Buffer.from(header, 'utf-8'),
      fileBuffer,
      Buffer.from(footer, 'utf-8')
    ]);

    const uploadRes = await fetch('http://localhost:5000/api/emails/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: bodyBuffer
    });

    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) {
      throw new Error(`Upload failed: ${uploadData.message}`);
    }

    console.log('✅ Upload successful!');
    console.log('Server response:', JSON.stringify(uploadData, null, 2));

  } catch (err) {
    console.error('❌ Error during verification:', err.message);
  } finally {
    // Clean up temporary file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log('🗑️ Temporary sample Excel file deleted.');
    }
    console.log('--- VERIFICATION FLOW COMPLETED ---');
  }
}

verify();
