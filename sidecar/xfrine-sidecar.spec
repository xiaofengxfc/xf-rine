# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller 打包配置：把关键位引擎打成 onedir 可执行文件。

为什么是 onedir 而不是 onefile：onefile 每次启动都要把 numpy/pandas/pyarrow 解包到临时目录，
几十兆解一次要好几秒 —— 而这是每次开程序的必经之路。onedir 装好之后直接跑。
"""

import os

BASE = os.path.abspath(SPECPATH)

# data/ 里是概率模型、标定表、复权因子。少一个，安装版就没有概率 —— 必须带上
datas = [(os.path.join(BASE, "data"), "data")]

# 这些模块是运行时按字符串/惰性导入的，静态分析有时跟不上，显式列出来
hiddenimports = [
    "pipeline",
    "src.sr_engine",
    "src.local_data_loader",
    "src.srlab.adjust",
    "src.srlab.base",
    "src.srlab.data",
    "src.srlab.detectors",
    "src.srlab.labeling",
    "src.srlab.leakage",
    "src.srlab.metrics",
    "src.srlab.pivots",
    "src.srlab.probability",
    "src.srlab.profile",
    "src.srlab.walkforward",
]

a = Analysis(
    ["service.py"],
    pathex=[BASE],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # 这些用不到，带上只会让安装包更胖
    excludes=["matplotlib", "tkinter", "PyQt5", "PySide6", "IPython", "notebook", "pytest"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="xfrine-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="xfrine-sidecar",
)
