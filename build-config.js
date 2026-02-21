const fs = require('fs');

const config = `
const firebaseConfig = {
  apiKey: "${process.env.FIREBASE_API_KEY || ''}",
  authDomain: "${process.env.FIREBASE_AUTH_DOMAIN || ''}",
  databaseURL: "${process.env.FIREBASE_DATABASE_URL || ''}",
  projectId: "${process.env.FIREBASE_PROJECT_ID || ''}",
  storageBucket: "${process.env.FIREBASE_STORAGE_BUCKET || ''}",
  messagingSenderId: "${process.env.FIREBASE_MESSAGING_SENDER_ID || ''}",
  appId: "${process.env.FIREBASE_APP_ID || ''}"
};
const ADMIN_UID = "${process.env.ADMIN_UID || ''}";
`;

fs.writeFileSync('config.js', config);
console.log('config.js generated from environment variables.');
