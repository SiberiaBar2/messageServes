const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const bodyParser = require("body-parser");
const path = require("path");
const app = express();
const port = 3004;

app.use(cors());
app.use(bodyParser.json());
// app.use(express.static(path.join(__dirname, '../frontend'))); // Serve static files from frontend

// 示例：在根路由设置一个简单的示例路由
app.get("/", (req, res) => {
  // res.send('科目管理后端，服务已经启动！');
  res.sendFile(__dirname + "/index.html"); // 发送 HTML 文件
});

// 动态设置数据库文件路径
const dbFile = process.env.VERCEL ? '/tmp/message.db' : path.resolve(__dirname, "message.db");

let db = new sqlite3.Database(dbFile, (err) => {
  if (err) {
    console.error("数据库连接失败：", err.message);
  } else {
    console.log("已连接到SQLite数据库");
  }
});

// 创建表（如果不存在）
const createTable = (level) => {
  const foreignKey = level > 1 ? `level${level - 1}_id` : null;
  const tableDefinition = `
    CREATE TABLE IF NOT EXISTS level${level} (
      id INTEGER PRIMARY KEY,
      ${foreignKey ? `${foreignKey} INTEGER,` : ""}
      name TEXT NOT NULL
      ${foreignKey ? `, FOREIGN KEY (${foreignKey}) REFERENCES level${level - 1}(id)` : ""}
    )
  `;
  db.run(tableDefinition);
};

// 动态创建层级表
for (let i = 1; i <= 10; i++) { // 假设最多支持10层
  createTable(i);
}

// 递归更新或插入嵌套数据
function upsertNestedData(level, parentId, data, callback) {
  if (!data || !data.name) {
    return callback(null);
  }

  const table = `level${level}`;
  const foreignKey = level > 1 ? `level${level - 1}_id` : null;
  const columns = foreignKey ? `${foreignKey}, name` : `name`;
  const placeholders = foreignKey ? `?, ?` : `?`;
  const params = foreignKey ? [parentId, data.name] : [data.name];

  // 检查是否已存在
  let query = `SELECT id FROM ${table} WHERE name = ?`;
  let queryParams = [data.name];
  if (foreignKey) {
    query += ` AND ${foreignKey} = ?`;
    queryParams.push(parentId);
  }

  db.get(query, queryParams, (err, row) => {
    if (err) {
      return callback(err);
    }

    if (row) {
      // 如果存在，更新它
      const updateQuery = `UPDATE ${table} SET name = ? WHERE id = ?`;
      db.run(updateQuery, [data.name, row.id], function (err) {
        if (err) {
          return callback(err);
        }

        const newId = row.id;
        upsertChildren(level + 1, newId, data.children, callback);
      });
    } else {
      // 如果不存在，插入新数据
      const insertQuery = `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`;
      db.run(insertQuery, params, function (err) {
        if (err) {
          return callback(err);
        }

        const newId = this.lastID;
        upsertChildren(level + 1, newId, data.children, callback);
      });
    }
  });
}

function upsertChildren(level, parentId, children, callback) {
  if (!children || children.length === 0) {
    return callback(null);
  }

  let counter = 0;
  children.forEach((child) => {
    upsertNestedData(level, parentId, child, (err) => {
      if (err) {
        return callback(err);
      }
      counter++;
      if (counter === children.length) {
        callback(null);
      }
    });
  });
}

// 递归获取树形数据
function getTreeData(level, parentId = null) {
  return new Promise((resolve, reject) => {
    const table = `level${level}`;
    const foreignKey = level > 1 ? `level${level - 1}_id` : null;

    let query = `SELECT * FROM ${table} WHERE ${foreignKey} IS NULL`;
    let params = [];
    if (foreignKey && parentId !== null) {
      query = `SELECT * FROM ${table} WHERE ${foreignKey} = ?`;
      params = [parentId];
    }

    db.all(query, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        let tree = [];
        rows.forEach((row) => {
          tree.push({
            id: row.id,
            name: row.name,
            children: [],
          });
        });
        // 递归获取子节点
        Promise.all(
          tree.map((node) =>
            getTreeData(level + 1, node.id).then((children) => {
              node.children = children;
            })
          )
        )
          .then(() => {
            resolve(tree);
          })
          .catch((err) => {
            reject(err);
          });
      }
    });
  });
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

app.post("/api/upsert", (req, res) => {
  const data = req.body;

  upsertNestedData(1, null, data, (err) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      res.json({ message: "嵌套数据更新或插入成功" });
    }
  });
});

// 捕获所有其他路由  
app.get('*', (req, res) => {  
    res.status(404).send('Not Found');  
  }); 

// 启动服务器
app.listen(port, () => {
  console.log(`服务器在 ${port} 上运行`);
});
