-- 个人工作台 · 一次性初始化（建库 + 建账号）
-- 用法：mysql -uroot -p < server/db/bootstrap.sql
-- 生产环境请务必把下面的密码换成自己的强密码，并同步写入 .env 的 DB_PASSWORD。

CREATE DATABASE IF NOT EXISTS `personal_workbench`
  DEFAULT CHARACTER SET utf8mb4;

-- 部分发行版（MariaDB / MySQL 5.7）初始化时会生成匿名账号，例如 ''@'localhost'。
-- 它比通配的 'workbench'@'%' 更具体，会抢先匹配并报 Access denied，因此先清掉。
-- MySQL 8 不存在匿名账号，这段会自然跳过。
SET @anon = (
  SELECT GROUP_CONCAT(CONCAT('''', `User`, '''@''', `Host`, '''') SEPARATOR ', ')
  FROM `mysql`.`user` WHERE `User` = ''
);
SET @sql = IFNULL(CONCAT('DROP USER IF EXISTS ', @anon), 'DO 0');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 应用账号：本机与局域网各建一个，避免 host 匹配问题
CREATE USER IF NOT EXISTS 'workbench'@'localhost' IDENTIFIED BY 'workbench';
CREATE USER IF NOT EXISTS 'workbench'@'%' IDENTIFIED BY 'workbench';

-- 只授权这一个库，不发放全局权限
GRANT ALL PRIVILEGES ON `personal_workbench`.* TO 'workbench'@'localhost';
GRANT ALL PRIVILEGES ON `personal_workbench`.* TO 'workbench'@'%';
FLUSH PRIVILEGES;
