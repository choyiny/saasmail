export async function handleEmail(
  message: ForwardableEmailMessage,
  env: CloudflareBindings,
  ctx: ExecutionContext
): Promise<void> {
  console.log(`Received email from ${message.from} to ${message.to}`);
}
