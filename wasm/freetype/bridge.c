#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_SYNTHESIS_H
#include FT_OUTLINE_H
#include <stdint.h>
static int last_error;
FT_Library font_init(void) {FT_Library lib=0;last_error=FT_Init_FreeType(&lib);return lib;}
void font_done(FT_Library lib) {FT_Done_FreeType(lib);}
int font_error(void) {return last_error;}
FT_Face font_open(FT_Library lib,const unsigned char *bytes,int length,int index) {FT_Face face=0;last_error=FT_New_Memory_Face(lib,bytes,length,index,&face);return face;}
void font_close(FT_Face face) {FT_Done_Face(face);}
int font_size(FT_Face face,int type,int width,int height,int xres,int yres) {
 FT_Size_RequestRec req={(FT_Size_Request_Type)type,width,height,(unsigned)xres,(unsigned)yres};return FT_Request_Size(face,&req);
}
int font_info(FT_Face f,int key) {
 switch(key){case 0:return f->units_per_EM;case 1:return f->ascender;case 2:return f->descender;case 3:return f->height;case 4:return f->max_advance_width;case 5:return f->max_advance_height;case 6:return f->num_glyphs;case 7:return f->num_faces;case 8:return f->size->metrics.x_ppem;case 9:return f->size->metrics.y_ppem;case 10:return f->size->metrics.ascender;case 11:return f->size->metrics.descender;case 12:return f->size->metrics.height;case 13:return f->size->metrics.max_advance;case 14:return f->underline_position;case 15:return f->underline_thickness;default:return 0;}
}
int font_glyph(FT_Face face,unsigned codepoint,int flags,int bold,int shear) {
 int error=FT_Load_Char(face,codepoint,flags);if(error)return error;
 if(bold)FT_GlyphSlot_Embolden(face->glyph);
 if(shear && face->glyph->format==FT_GLYPH_FORMAT_OUTLINE){FT_Matrix matrix={0x10000,shear,0,0x10000};FT_Outline_Transform(&face->glyph->outline,&matrix);}
 return 0;
}
int font_glyph_info(FT_Face f,int key) {
 FT_GlyphSlot g=f->glyph;
 switch(key){case 0:return g->bitmap.width;case 1:return g->bitmap.rows;case 2:return g->bitmap.pitch;case 3:return g->bitmap_left;case 4:return g->bitmap_top;case 5:return g->advance.x;case 6:return g->advance.y;case 7:return g->bitmap.pixel_mode;case 8:return (int)(uintptr_t)g->bitmap.buffer;case 9:return 0;case 10:return g->metrics.width;case 11:return g->metrics.height;default:return 0;}
}
int font_version(int key) {return key==0?FREETYPE_MAJOR:key==1?FREETYPE_MINOR:FREETYPE_PATCH;}

int font_char_index(FT_Face face,unsigned codepoint) {return FT_Get_Char_Index(face,codepoint);}
