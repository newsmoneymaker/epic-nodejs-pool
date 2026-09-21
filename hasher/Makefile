# Needs librandomx (https://github.com/tevador/RandomX) and OpenSSL headers.
# RANDOMX=/path/to/prefix make        (prefix has include/randomx.h and lib/librandomx.a)
RANDOMX ?= /usr/local
CXX ?= g++
veilhash: veilhash.cpp
	$(CXX) -O2 -std=c++11 -pthread -I$(RANDOMX)/include -o $@ $< $(RANDOMX)/lib/librandomx.a -lcrypto
clean:
	rm -f veilhash

# Epic Cash: RandomX of the Epic node (github.com/EpicCash/randomx, other instruction frequencies and AES keys), blob hashed as it is.
# EPICRANDOMX=/path/to/prefix make epichash    (prefix has include/randomx.h and lib/librandomx.a built from EpicCash/randomx)
EPICRANDOMX ?= /usr/local
epichash: veilhash.cpp
	$(CXX) -O2 -std=c++11 -pthread -I$(EPICRANDOMX)/include -o $@ $< $(EPICRANDOMX)/lib/librandomx.a -lcrypto
