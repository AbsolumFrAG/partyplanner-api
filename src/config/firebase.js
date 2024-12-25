const admin = require("firebase-admin");

const initializeFirebase = () => {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
};

const sendPushNotification = async (userTokens, title, body) => {
  const message = {
    notification: { title, body },
    tokens: userTokens,
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log("Successfully sent notifications:", response);
    return response;
  } catch (error) {
    console.error("Error sending notifications:", error);
    throw error;
  }
};

module.exports = { initializeFirebase, sendPushNotification };
