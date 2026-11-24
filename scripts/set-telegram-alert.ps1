# Stores the Telegram bot token (typed hidden) and the chat id for Alertmanager, in deploy/prod/secrets/ (git-ignored).
# Run it yourself in a terminal: the token is never shown on screen and never passed through any assistant.
#   & .\scripts\set-telegram-alert.ps1
# Before: create the bot with @BotFather (/newbot) and send any message to the bot (or to the group it was added to).
$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot '..\deploy\prod\secrets'
New-Item -ItemType Directory -Force $dir | Out-Null

$secure = Read-Host 'Telegram bot token (input is hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
$token = $token.Trim()
if ($token -notmatch '^\d{6,12}:[A-Za-z0-9_-]{30,60}$') { throw 'That does not look like a BotFather token (digits, a colon, then letters/digits).' }

$me = Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/getMe" -TimeoutSec 20
if (-not $me.ok) { throw 'Telegram refused the token.' }
Write-Host ("Token accepted for bot @{0}" -f $me.result.username)

# Chat id: the latest chat that wrote to the bot; otherwise ask.
$chat = $null
try {
  $updates = Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/getUpdates" -TimeoutSec 20
  $last = @($updates.result | Where-Object { $_.message -or $_.channel_post -or $_.my_chat_member }) | Select-Object -Last 1
  if ($last) {
    if ($last.message) { $chat = $last.message.chat } elseif ($last.channel_post) { $chat = $last.channel_post.chat } else { $chat = $last.my_chat_member.chat }
  }
} catch { }
if ($chat) {
  $label = if ($chat.title) { $chat.title } else { $chat.first_name }
  $ok = Read-Host ("Send alerts to chat '{0}' (id {1})? [Y/n]" -f $label, $chat.id)
  if ($ok -match '^[nN]') { $chat = $null }
}
if ($chat) { $chatId = [string]$chat.id } else { $chatId = (Read-Host 'Chat id (a group id is negative)').Trim() }
if ($chatId -notmatch '^-?\d{5,20}$') { throw 'The chat id must be a number.' }

# Write without a BOM or newline, readable by the current user only (Alertmanager reads them through a read-only mount).
$enc = New-Object System.Text.UTF8Encoding($false)
foreach ($pair in @(@('telegram_bot_token', $token), @('telegram_chat_id', $chatId))) {
  $path = Join-Path $dir $pair[0]
  [System.IO.File]::WriteAllText($path, $pair[1], $enc)
  icacls $path /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
}

# One real test message to that chat (your own bot).
$body = @{ chat_id = $chatId; text = 'DavraBox alerts: connection test OK' }
$sent = Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/sendMessage" -Body $body -TimeoutSec 20
if ($sent.ok) { Write-Host 'Test message sent. Secrets saved in deploy/prod/secrets/ (not in git).' } else { Write-Host 'Saved, but the test message failed: check that the bot is allowed to write in that chat.' }
$token = $null
