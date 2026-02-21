$htmlPath = "c:\Users\grego\Documents\LAN-demain\LAN-demain\index.html"
$newScriptPath = "c:\Users\grego\Documents\LAN-demain\LAN-demain\newScript.js"

$html = Get-Content -Raw -Path $htmlPath
$newScript = Get-Content -Raw -Path $newScriptPath

$configScriptIdx = $html.IndexOf('<script src="config.js"></script>')
$actualStart = $html.IndexOf('<script>', $configScriptIdx + 10)
$actualEnd = $html.IndexOf('</script>', $actualStart)

if ($actualStart -ne -1 -and $actualEnd -ne -1) {
    $newHtml = $html.Substring(0, $actualStart + 8) + "`n" + $newScript + "`n    " + $html.Substring($actualEnd)
    Set-Content -Path $htmlPath -Value $newHtml -Encoding UTF8
    Write-Host "Successfully updated index.html script block"
} else {
    Write-Host "Failed to find script tags"
}
