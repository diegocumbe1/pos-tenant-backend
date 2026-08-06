-- DropIndex
DROP INDEX "platform_message_templates_key_key";

-- CreateIndex
CREATE UNIQUE INDEX "platform_message_templates_key_channel_key" ON "platform_message_templates"("key", "channel");

