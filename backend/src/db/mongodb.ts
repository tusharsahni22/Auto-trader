/**
 * MongoDB connection manager
 * Handles connection lifecycle and provides singleton access to the database
 */

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://admin:changeme@localhost:27017/autotrader?authSource=admin';

let isConnected = false;

export async function connectMongoDB(): Promise<void> {
  if (isConnected) {
    console.log('[mongodb] using existing connection');
    return;
  }

  try {
    const options = {
      maxPoolSize: 10,
      minPoolSize: 2,
      socketTimeoutMS: 45000,
      serverSelectionTimeoutMS: 5000,
    };

    await mongoose.connect(MONGODB_URI, options);
    isConnected = true;
    console.log('[mongodb] connected successfully');

    mongoose.connection.on('error', (err) => {
      console.error('[mongodb] connection error:', err);
      isConnected = false;
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('[mongodb] disconnected');
      isConnected = false;
    });

  } catch (error) {
    console.error('[mongodb] connection failed:', error);
    throw error;
  }
}

export async function disconnectMongoDB(): Promise<void> {
  if (!isConnected) {
    return;
  }

  try {
    await mongoose.disconnect();
    isConnected = false;
    console.log('[mongodb] disconnected');
  } catch (error) {
    console.error('[mongodb] disconnect error:', error);
    throw error;
  }
}

export function getMongoConnection() {
  return mongoose.connection;
}

export function isMongoConnected(): boolean {
  return isConnected && mongoose.connection.readyState === 1;
}
