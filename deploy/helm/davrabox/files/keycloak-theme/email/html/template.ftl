<#-- Shared layout of every DavraBox email: a light card, the wordmark, the body and a short footer. Inline styles only. -->
<#macro emailLayout>
<!DOCTYPE html>
<html lang="${msg("dbLang")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>DavraBox</title>
</head>
<body style="margin:0;padding:0;background:#f4f5fb;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5fb;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #d5d9ee;border-radius:12px;">
<tr><td style="padding:24px 28px 4px 28px;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;color:#087069;letter-spacing:0.2px;">DavraBox</td></tr>
<tr><td style="padding:8px 28px 28px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#12163a;">
<#nested>
</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td style="padding:14px 28px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#454c7a;">${msg("dbFooter")}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
</#macro>

<#macro title text>
<h1 style="margin:12px 0 12px 0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:1.3;color:#12163a;">${text}</h1>
</#macro>

<#macro para text>
<p style="margin:0 0 14px 0;">${text}</p>
</#macro>

<#macro muted text>
<p style="margin:0 0 10px 0;font-size:13px;line-height:1.5;color:#454c7a;">${text}</p>
</#macro>

<#-- The action: a large button, then the plain link for clients that do not show buttons. -->
<#macro button href label>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 18px 0;">
<tr><td style="border-radius:8px;background:#087069;">
<a href="${href}" target="_blank" style="display:inline-block;padding:13px 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${label}</a>
</td></tr>
</table>
<p style="margin:0 0 16px 0;font-size:13px;line-height:1.5;color:#454c7a;">${msg("dbLinkFallback")}<br><a href="${href}" target="_blank" style="color:#087069;word-break:break-all;">${href}</a></p>
</#macro>
