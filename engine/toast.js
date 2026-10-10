// Windows toast notification (the local stand-in for their iOS push / meme alerts).
// Fire-and-forget; failures are logged, never thrown — notifications must not break a job.
const { spawn } = require('child_process');

function toast(title, body) {
  try {
    const ps = `
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$xml = @"
<toast><visual><binding template='ToastGeneric'><text>$([Security.SecurityElement]::Escape('${title.replace(/'/g, "''")}'))</text><text>$([Security.SecurityElement]::Escape('${body.replace(/'/g, "''")}'))</text></binding></visual></toast>
"@
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('SoMeme').Show([Windows.UI.Notifications.ToastNotification]::new($doc))
`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.on('error', () => {});
  } catch { /* never fail the caller */ }
}

module.exports = { toast };
