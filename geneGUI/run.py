#!/usr/bin/env python3
"""
Entry point for B-cell Repertoire Analysis GUI
"""
import sys
import os

# Add current directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import and run the main GUI
from src.gui.main import *

if __name__ == '__main__':
    app = QApplication([])
    icon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src', 'gui', 'cells.icns')
    app.setWindowIcon(QIcon(icon_path))
    controler = QStackedWidget()
    #generates the main window and window "holder"
    menuW = menuWindow(controller=controler)  # Pass controller to menuWindow
    controler.addWidget(menuW)
    controler.setGeometry(100,100,1200,700)
    controler.show()
    sys.exit(app.exec())

