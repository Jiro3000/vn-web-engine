/* Preserve upstream 2.4.8 options except unbuilt compression/file adapters. */
#include "../vendor/include/freetype/config/ftoption.h"
#undef FT_CONFIG_OPTION_USE_ZLIB
#undef FT_CONFIG_OPTION_USE_LZW
#undef FT_CONFIG_OPTION_MAC_FONTS
