To add projects automatically:

1. **Install ImageMagick** (required for HEIC conversion)
   - Download from: https://imagemagick.org/script/download.php
   - Run the installer
   - Restart PowerShell after installation

2. Create a folder inside `projects_input` with the project name (e.g., "Kitchen Renovation")

3. Add image files to that folder:
   - Supported formats: .jpg, .jpeg, .png, .gif, .heic
   - HEIC files (from iPhones) are automatically converted to JPG

4. Optionally, add a `description.txt` file with the project description

5. Run `.\add_project.ps1` in PowerShell

The script will:
- Convert HEIC files to JPG automatically
- Resize images if they're wider than 1200px
- Compress JPGs to 80% quality
- Create project entries in `projects.json`
- Use folder name as project name
- Use description.txt content or default description

Example structure:
```
projects_input/
  Kitchen Renovation/
    description.txt
    before.heic
    after.jpg
  Bathroom Update/
    description.txt
    image1.png
    image2.png
```