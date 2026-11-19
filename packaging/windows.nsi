Unicode True
!include "MUI2.nsh"
!include "x64.nsh"
Name "PhysLlama"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\PhysLlama"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "PhysLlama requires 64-bit Windows."
    Abort
  ${EndIf}
  MessageBox MB_OKCANCEL "Close PhysLlama before installing or updating. Export measurements, then use Quit app in its browser window." IDOK proceed
  Abort
  proceed:
FunctionEnd

Section "PhysLlama"
  SetRegView 64
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*"
  CreateDirectory "$SMPROGRAMS\PhysLlama"
  CreateShortcut "$SMPROGRAMS\PhysLlama\PhysLlama.lnk" "$INSTDIR\python\pythonw.exe" '-I "$INSTDIR\app\desktop.py"'
  CreateShortcut "$DESKTOP\PhysLlama.lnk" "$INSTDIR\python\pythonw.exe" '-I "$INSTDIR\app\desktop.py"'
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhysLlama" "DisplayName" "PhysLlama"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhysLlama" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhysLlama" "UninstallString" '$"$INSTDIR\Uninstall.exe$"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhysLlama" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhysLlama" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhysLlama" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetRegView 64
  MessageBox MB_OKCANCEL "Close PhysLlama before uninstalling. Export measurements, then use Quit app." IDOK remove
  Abort
  remove:
  Delete "$DESKTOP\PhysLlama.lnk"
  Delete "$SMPROGRAMS\PhysLlama\PhysLlama.lnk"
  RMDir "$SMPROGRAMS\PhysLlama"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\deps"
  RMDir /r "$INSTDIR\python"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.md"
  Delete "$INSTDIR\BUILD-MANIFEST.json"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PhysLlama"
SectionEnd
