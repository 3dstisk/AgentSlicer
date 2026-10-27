# Container images

AppImage extraction can create root-owned directories with owner-only access.
Make the installed public application tree readable and traversable by the
runtime user, preserving executable file bits. Verify the actual AppRun launcher
as `abc` during image assembly; root-only executable checks miss this failure.
Keep persistent configuration and private session directories outside that
permission normalization. Cold-start readiness and authenticated Docker E2E
also exercise GUI, OpenGL and preset initialization.
