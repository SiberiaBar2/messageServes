const express = require("express");
const cors = require("cors");
require("dotenv").config();

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
  user: "postgres.bswwoqwjolxtpjnzyxxf",
  host: "aws-0-ap-southeast-1.pooler.supabase.com",
  database: "postgres",
  password: "CMjzbC6R@#!K5BX",
  port: 5432,
  ssl: {
    rejectUnauthorized: false,
  },
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
      ${
        foreignKey
          ? `, FOREIGN KEY (${foreignKey}) REFERENCES level${level - 1}(id)`
          : ""
      }
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
    const insertQuery = `INSERT INTO ${table} (${columns}) VALUES (${values
      .map((_, i) => `$${i + 1}`)
      .join(", ")}) RETURNING id`;
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
  const tree = await Promise.all(
    res.rows.map(async (row) => {
      const children = await getTreeData(level + 1, row.id);
      return {
        id: row.id,
        name: row.name,
        children: children,
        level: level,
      };
    })
  );
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
    return res
      .status(400)
      .json({ error: "数据格式错误，期望为数组", ...ERRORCONFIG });
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

// 新增的接口，接受parentId和child数组，并将child数组追加到parentId对应的节点的children下
app.post("/api/addChild", async (req, res) => {
  const { parentId = null, child } = req.body;

  // 检查 child 是否为数组
  if (!Array.isArray(child)) {
    return res
      .status(400)
      .json({ error: "数据格式错误，期望child为数组", ...ERRORCONFIG });
  }

  try {
    if (parentId === null) {
      // 如果 parentId 为 null，则追加到一级表中
      for (const item of child) {
        await upsertNestedData(1, null, item);
      }
    } else {
      // 逐个表地检查 parentId 是否存在，并获取对应的层级
      let level = 0;
      let parentNode;
      for (let i = 1; i <= 10; i++) {
        const query = `SELECT * FROM level${i} WHERE id = $1`;
        const result = await pool.query(query, [parentId]);
        if (result.rows.length > 0) {
          level = i;
          parentNode = result.rows[0];
          break;
        }
      }

      if (level === 0) {
        return res
          .status(400)
          .json({ error: "无效的 parentId", ...ERRORCONFIG });
      }

      // 获取现有的子节点
      const existingChildren = await getTreeData(level + 1, parentId);
      const existingNames = existingChildren.map((child) => child.name);

      // 将新的子节点与现有的子节点合并
      for (const item of child) {
        if (!existingNames.includes(item.name)) {
          await upsertNestedData(level + 1, parentId, item);
        }
      }
    }

    res.json({ message: "子节点添加成功", ...SUCCESSCONFIG });
  } catch (err) {
    res.status(500).json({ error: err.message, ...ERRORCONFIG });
  }
});

// 编辑节点接口
app.post("/api/editNode", async (req, res) => {
  const { id, name } = req.body;

  // 检查是否传入了 id 和 name
  if (!id || !name) {
    return res
      .status(400)
      .json({ error: "参数错误，必须提供 id 和 name", ...ERRORCONFIG });
  }

  try {
    // 找到节点对应的层级
    let level = 0;
    for (let i = 1; i <= 10; i++) {
      const query = `SELECT * FROM level${i} WHERE id = $1`;
      const result = await pool.query(query, [id]);
      if (result.rows.length > 0) {
        level = i;
        break;
      }
    }

    if (level === 0) {
      return res.status(400).json({ error: "无效的 id", ...ERRORCONFIG });
    }

    // 更新节点名称
    const updateQuery = `UPDATE level${level} SET name = $1 WHERE id = $2`;
    await pool.query(updateQuery, [name, id]);

    res.json({ message: "节点名称更新成功", ...SUCCESSCONFIG });
  } catch (err) {
    res.status(500).json({ error: err.message, ...ERRORCONFIG });
  }
});

// 删除节点及其所有子节点接口
app.post("/api/deleteNode", async (req, res) => {
  const { id } = req.body;

  // 检查是否传入了 id
  if (!id) {
    return res
      .status(400)
      .json({ error: "参数错误，必须提供 id", ...ERRORCONFIG });
  }

  try {
    // 找到节点对应的层级
    let level = 0;
    for (let i = 1; i <= 10; i++) {
      const query = `SELECT * FROM level${i} WHERE id = $1`;
      const result = await pool.query(query, [id]);
      if (result.rows.length > 0) {
        level = i;
        break;
      }
    }

    if (level === 0) {
      return res.status(400).json({ error: "无效的 id", ...ERRORCONFIG });
    }

    // 递归删除节点及其子节点
    await deleteNodeAndChildren(level, id);

    res.json({ message: "节点及其所有子节点删除成功", ...SUCCESSCONFIG });
  } catch (err) {
    res.status(500).json({ error: err.message, ...ERRORCONFIG });
  }
});

// 递归删除节点及其子节点的辅助函数
async function deleteNodeAndChildren(level, parentId) {
  if (level >= 10) return; // 超过最大层级，不再递归

  const currentTable = `level${level}`;
  const nextTable = `level${level + 1}`;
  const foreignKey = `level${level}_id`;

  try {
    // 查询当前节点的子节点
    const query = `SELECT id FROM ${nextTable} WHERE ${foreignKey} = $1`;
    const result = await pool.query(query, [parentId]);

    // 递归删除所有子节点
    for (const row of result.rows) {
      await deleteNodeAndChildren(level + 1, row.id);
    }

    // 删除当前节点
    const deleteQuery = `DELETE FROM ${currentTable} WHERE id = $1`;
    await pool.query(deleteQuery, [parentId]);
  } catch (error) {
    console.error(`Error deleting nodes at level ${level}: ${error.message}`);
    throw error;
  }
}

app.get("*", (req, res) => {
  res.status(404).send("Not Found");
});
