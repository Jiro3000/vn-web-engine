/* Memory-only FreeType adapter. No filesystem or OS calls are exposed. */
#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_SYSTEM_H
#include <stdlib.h>
static void *alloc(FT_Memory memory, long size) { (void)memory; return malloc(size); }
static void dealloc(FT_Memory memory, void *block) { (void)memory; free(block); }
static void *resize(FT_Memory memory, long current, long size, void *block) { (void)memory; (void)current; return realloc(block,size); }
FT_Memory FT_New_Memory(void) { FT_Memory m=malloc(sizeof(*m)); if(m){m->user=0;m->alloc=alloc;m->free=dealloc;m->realloc=resize;}return m; }
void FT_Done_Memory(FT_Memory memory) { free(memory); }
FT_Error FT_Stream_Open(FT_Stream stream, const char *path) { (void)stream;(void)path;return 7; }
