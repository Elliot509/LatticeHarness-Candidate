Option Explicit
Dim files, shell, root, command
Set files = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = files.GetParentFolderName(WScript.ScriptFullName)
command = Chr(34) & root & "\app\runtime\electron.exe" & Chr(34) & " " & Chr(34) & root & "\app" & Chr(34)
shell.Run command, 1, False
