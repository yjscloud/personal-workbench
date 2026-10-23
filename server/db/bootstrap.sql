-- 个人工作台 · 一次性初始化（建库 + 建账号）
-- 用法：
--   1) 先生成一个强口令：openssl rand -hex 24
--   2) 把下面的 __DB_PASSWORD__ 换成它（两处），执行：
--        mysql -uroot -p < server/db/bootstrap.sql
--   3) 把同一个口令写进 .env 的 DB_PASSWORD
--
-- 这个脚本刻意不建 'workbench'@'%'：应用和数据库同机，没有任何正当理由
-- 让局域网里任意主机拿这个账号登录。3306 也不要对外绑定 —— 见 README，
-- MariaDB 配 bind-address=127.0.0.1。

CREATE DATABASE IF NOT EXISTS `personal_workbench`
  DEFAULT CHARACTER SET utf8mb4;

-- 部分发行版（MariaDB / MySQL 5.7）初始化时会生成匿名账号，例如 ''@'localhost'。
-- 它比具名账号更具体，会抢先匹配并报 Access denied，因此先清掉。
-- MySQL 8 不存在匿名账号，这段会自然跳过。
SET @anon = (
  SELECT GROUP_CONCAT(CONCAT('''', `User`, '''@''', `Host`, '''') SEPARATOR ', ')
  FROM `mysql`.`user` WHERE `User` = ''
);
SET @sql = IFNULL(CONCAT('DROP USER IF EXISTS ', @anon), 'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 应用账号：只允许本机。
--   127.0.0.1 这个条目是给 skip-name-resolve=ON 的环境用的：那种情况下
--   TCP 连到 127.0.0.1 不会被解析成 localhost，少了它会报 Access denied。
CREATE USER IF NOT EXISTS 'workbench'@'localhost' IDENTIFIED BY '__DB_PASSWORD__';
CREATE USER IF NOT EXISTS 'workbench'@'127.0.0.1' IDENTIFIED BY '__DB_PASSWORD__';
ALTER USER 'workbench'@'localhost' IDENTIFIED BY '__DB_PASSWORD__';
ALTER USER 'workbench'@'127.0.0.1' IDENTIFIED BY '__DB_PASSWORD__';

-- 只授业务库，且不给 DROP / FILE / PROCESS 这类越界权限。
-- CREATE + ALTER 是运行时建表与补列（server/db/schema.js）需要的：
-- 本项目的表结构跟着代码演进，启动时会 CREATE TABLE IF NOT EXISTS、
-- 并给老库补列。除此之外的 DDL（DROP TABLE / DROP DATABASE）用不到。
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'workbench'@'localhost';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'workbench'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON `personal_workbench`.* TO 'workbench'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON `personal_workbench`.* TO 'workbench'@'127.0.0.1';
FLUSH PRIVILEGES;
