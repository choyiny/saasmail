ALTER TABLE `emails` ADD COLUMN `spf` text;
ALTER TABLE `emails` ADD COLUMN `dkim` text;
ALTER TABLE `emails` ADD COLUMN `dmarc` text;
