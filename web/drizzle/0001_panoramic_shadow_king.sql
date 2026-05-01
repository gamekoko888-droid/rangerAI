CREATE TABLE `chats` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`sessionKey` varchar(128) NOT NULL,
	`title` varchar(200) NOT NULL DEFAULT '新对话',
	`model` varchar(100),
	`titleGenerated` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `chats_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`chatId` varchar(36) NOT NULL,
	`role` enum('user','assistant','system') NOT NULL,
	`content` text NOT NULL,
	`model` varchar(100),
	`tokens` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `chats_userId_idx` ON `chats` (`userId`);--> statement-breakpoint
CREATE INDEX `chats_sessionKey_idx` ON `chats` (`sessionKey`);--> statement-breakpoint
CREATE INDEX `messages_chatId_idx` ON `messages` (`chatId`);