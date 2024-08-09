const express = require("express");
const cors = require("cors");
require('dotenv').config();

const { Pool } = require("pg");
const bodyParser = require("body-parser");
const path = require("path");
const app = express();
const port = 3004;

app.use(cors());
app.use(bodyParser.json());

const SUCCESSCONFIG = {
  code: 200,
  status: "success",
};

const ERRORCONFIG = {
  code: 500,
  status: "error",
  message: "服务器内部错误",
};

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

const pool = new Pool({
  user: 'postgres.bswwoqwjolxtpjnzyxxf',
  host: 'aws-0-ap-southeast-1.pooler.supabase.com',
  database: 'postgres',
  password: 'CMjzbC6R@#!K5BX',
  port: 5432,
  ssl: {
    rejectUnauthorized: false
  }
});

const tableExists = async (tableName) => {
  const query = `
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = $1
    )
  `;
  const res = await pool.query(query, [tableName]);
  return res.rows[0].exists;
};

const createTable = async (level) => {
  const tableName = `level${level}`;
  if (await tableExists(tableName)) {
    console.log(`Table ${tableName} already exists`);
    return;
  }
  
  const foreignKey = level > 1 ? `level${level - 1}_id` : null;
  const tableDefinition = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id SERIAL PRIMARY KEY,
      ${foreignKey ? `${foreignKey} INTEGER,` : ""}
      name TEXT NOT NULL
      ${foreignKey ? `, FOREIGN KEY (${foreignKey}) REFERENCES level${level - 1}(id)` : ""}
    )
  `;
  try {
    await pool.query(tableDefinition);
    console.log(`Table ${tableName} created successfully`);
  } catch (error) {
    console.error(`Error creating table ${tableName}: ${error.message}`);
  }
};

(async () => {
  for (let i = 1; i <= 10; i++) {
    await createTable(i);
  }

  app.listen(port, () => {
    console.log(`服务器在 ${port} 上运行`);
  });
})();

async function upsertNestedData(level, parentId, data) {
  if (!data || !data.name) {
    return;
  }

  const table = `level${level}`;
  const foreignKey = level > 1 ? `level${level - 1}_id` : null;
  const columns = foreignKey ? `${foreignKey}, name` : `name`;
  const values = foreignKey ? [parentId, data.name] : [data.name];

  let query = `SELECT id FROM ${table} WHERE name = $1`;
  let queryParams = [data.name];
  if (foreignKey) {
    query += ` AND ${foreignKey} = $2`;
    queryParams.push(parentId);
  }

  const res = await pool.query(query, queryParams);
  if (res.rows.length > 0) {
    const updateQuery = `UPDATE ${table} SET name = $1 WHERE id = $2`;
    await pool.query(updateQuery, [data.name, res.rows[0].id]);
    const newId = res.rows[0].id;
    await upsertChildren(level + 1, newId, data.children);
  } else {
    const insertQuery = `INSERT INTO ${table} (${columns}) VALUES (${values.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`;
    const insertRes = await pool.query(insertQuery, values);
    const newId = insertRes.rows[0].id;
    await upsertChildren(level + 1, newId, data.children);
  }
}

async function upsertChildren(level, parentId, children) {
  if (!children || children.length === 0) {
    return;
  }

  for (const child of children) {
    await upsertNestedData(level, parentId, child);
  }
}

async function getTreeData(level, parentId = null) {
  const table = `level${level}`;
  const foreignKey = level > 1 ? `level${level - 1}_id` : null;

  let query = `SELECT * FROM ${table} WHERE ${foreignKey} IS NULL`;
  let params = [];
  if (foreignKey && parentId !== null) {
    query = `SELECT * FROM ${table} WHERE ${foreignKey} = $1`;
    params = [parentId];
  }

  const res = await pool.query(query, params);
  const tree = await Promise.all(res.rows.map(async (row) => {
    const children = await getTreeData(level + 1, row.id);
    return {
      id: row.id,
      name: row.name,
      children: children,
      level: level
    };
  }));
  return tree;
}

app.get("/api/tree", async (req, res) => {
  try {
    const treeData = await getTreeData(1);
    res.json({ treeData, ...SUCCESSCONFIG });
  } catch (err) {
    res.status(500).json({ error: err.message, ...ERRORCONFIG });
  }
});

app.post("/api/upsert", async (req, res) => {
  const data = req.body;

  // 检查接收到的数据是否为数组
  if (!Array.isArray(data)) {
    return res.status(400).json({ error: "数据格式错误，期望为数组", ...ERRORCONFIG });
  }

  try {
    // 清空所有表数据
    for (let i = 10; i >= 1; i--) {
      await pool.query(`TRUNCATE TABLE level${i} CASCADE`);
    }

    // 遍历数组并处理每一个根节点
    for (const item of data) {
      await upsertNestedData(1, null, item);
    }

    res.json({ message: "嵌套数据更新或插入成功", ...SUCCESSCONFIG });
  } catch (err) {
    res.status(500).json({ error: err.message, ...ERRORCONFIG });
  }
});

// 清除所有树形数据
app.post("/api/clear", async (req, res) => {
  try {
    for (let i = 10; i >= 1; i--) {
      await pool.query(`TRUNCATE TABLE level${i} CASCADE`);
    }
    res.json({ message: "所有树形数据已清除", ...SUCCESSCONFIG });
  } catch (err) {
    res.status(500).json({ error: err.message, ...ERRORCONFIG });
  }
});

app.get('*', (req, res) => {
  res.status(404).send('Not Found');
});
