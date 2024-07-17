const express = require("express");
const cors = require("cors");
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const bodyParser = require("body-parser");

const app = express();
const port = 3004;

app.use(cors());
app.use(bodyParser.json());

// 示例：在根路由设置一个简单的示例路由
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html"); // 发送 HTML 文件
});

// 创建 Supabase 客户端
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// 创建表（如果不存在）
const createTable = async (level) => {
  const foreignKey = level > 1 ? `level${level - 1}_id` : null;
  const tableDefinition = `
    CREATE TABLE IF NOT EXISTS level${level} (
      id SERIAL PRIMARY KEY,
      ${foreignKey ? `${foreignKey} INTEGER,` : ""}
      name TEXT NOT NULL
      ${foreignKey ? `, FOREIGN KEY (${foreignKey}) REFERENCES level${level - 1}(id)` : ""}
    )
  `;
  await supabase.rpc('execute_sql', { sql: tableDefinition });
};

// 动态创建层级表
for (let i = 1; i <= 10; i++) { // 假设最多支持10层
  createTable(i);
}

// 递归更新或插入嵌套数据
async function upsertNestedData(level, parentId, data) {
  if (!data || !data.name) {
    return;
  }

  const table = `level${level}`;
  const foreignKey = level > 1 ? `level${level - 1}_id` : null;

  // 检查是否已存在
  let query = `SELECT id FROM ${table} WHERE name = $1`;
  let queryParams = [data.name];
  if (foreignKey) {
    query += ` AND ${foreignKey} = $2`;
    queryParams.push(parentId);
  }

  const res = await supabase.from(table).select('id').eq('name', data.name).eq(foreignKey, parentId);
  if (res.data.length > 0) {
    // 如果存在，更新它
    await supabase.from(table).update({ name: data.name }).eq('id', res.data[0].id);
    const newId = res.data[0].id;
    await upsertChildren(level + 1, newId, data.children);
  } else {
    // 如果不存在，插入新数据
    const insertRes = await supabase.from(table).insert({ name: data.name, [foreignKey]: parentId }).select('id');
    const newId = insertRes.data[0].id;
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

// 递归获取树形数据
async function getTreeData(level, parentId = null) {
  const table = `level${level}`;
  const foreignKey = level > 1 ? `level${level - 1}_id` : null;

  let query = supabase.from(table).select('*');

  if (foreignKey && parentId !== null) {
    query = query.eq(foreignKey, parentId);
  } else if (!foreignKey) {
    query = query.isNull(foreignKey);
  }

  const res = await query;
  const tree = await Promise.all(res.data.map(async (row) => {
    const children = await getTreeData(level + 1, row.id);
    return {
      id: row.id,
      name: row.name,
      children: children,
    };
  }));
  return tree;
}

// 获取所有树形数据
app.get("/api/tree", async (req, res) => {
  try {
    const treeData = await getTreeData(1);
    res.json({ treeData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/upsert", async (req, res) => {
  const data = req.body;

  try {
    await upsertNestedData(1, null, data);
    res.json({ message: "嵌套数据更新或插入成功" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 捕获所有其他路由  
app.get('*', (req, res) => {  
    res.status(404).send('Not Found');  
}); 

// 启动服务器
app.listen(port, () => {
  console.log(`服务器在 ${port} 上运行`);
});
