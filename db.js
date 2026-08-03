const { MongoClient } = require('mongodb');

const uri = "mongodb+srv://atomnharnhar97_db_user:0Qba9fyKsUbBmwzO@youngmind.r9mp73k.mongodb.net/?appName=youngmind";

async function testConnection() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    console.log("✅ Connected successfully to MongoDB!");
    const databases = await client.db().admin().listDatabases();
    console.log("📊 Databases:", databases.databases.map(d => d.name).join(", "));
  } catch (error) {
    console.error("❌ Connection failed:", error.message);
  } finally {
    await client.close();
  }
}

testConnection();