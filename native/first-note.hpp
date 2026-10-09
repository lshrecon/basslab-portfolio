#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <string>

// Dedicated rolling input display, not the frozen offline detector chain.
// PCM remains in a fixed ring and is never saved by the FIRST_NOTE action.
namespace basslab::firstnote {
constexpr std::size_t Frames=8192,Decimation=4,N=Frames/Decimation;
constexpr double Rate=44100.0/Decimation;
struct Estimate {bool available=false;double midi=0,hz=0,clarity=0,levelDbfs=-120;std::string name;};
class Tracker {
    std::array<float,Frames> samples_{};std::size_t written_=0,position_=0;
public:
    void push(float v){samples_[position_]=v;position_=(position_+1)%Frames;if(written_<Frames)++written_;}
    std::size_t memoryFrames()const{return written_;}
    Estimate estimate()const{
        Estimate out;double energy=0;
        for(std::size_t i=0;i<written_;++i)energy+=static_cast<double>(samples_[i])*samples_[i];
        if(written_)out.levelDbfs=20*std::log10((std::max)(1e-6,std::sqrt(energy/static_cast<double>(written_))));
        if(written_<Frames||out.levelDbfs<-55)return out;
        std::array<double,N> signal{};double average=0;
        for(std::size_t i=0;i<N;++i){for(std::size_t k=0;k<Decimation;++k)signal[i]+=samples_[(position_+i*Decimation+k)%Frames]/Decimation;average+=signal[i];}
        average/=N;for(auto& v:signal)v-=average;
        constexpr std::size_t MinLag=27,MaxLag=315;
        std::array<double,MaxLag+2> nsdf{};double best=0;
        for(std::size_t lag=MinLag-1;lag<=MaxLag+1;++lag){double cross=0,power=0;for(std::size_t i=0;i+lag<N;++i){cross+=signal[i]*signal[i+lag];power+=signal[i]*signal[i]+signal[i+lag]*signal[i+lag];}nsdf[lag]=power>1e-14?2*cross/power:0;}
        for(std::size_t lag=MinLag;lag<=MaxLag;++lag)if(nsdf[lag]>=nsdf[lag-1]&&nsdf[lag]>nsdf[lag+1])best=(std::max)(best,nsdf[lag]);
        if(best<0.85)return out;
        std::size_t chosen=0;
        for(std::size_t lag=MinLag;lag<=MaxLag;++lag)if(nsdf[lag]>=nsdf[lag-1]&&nsdf[lag]>nsdf[lag+1]&&nsdf[lag]>=0.92*best){chosen=lag;break;}
        if(!chosen)return out;const auto denominator=2*(2*nsdf[chosen]-nsdf[chosen-1]-nsdf[chosen+1]);
        const auto shift=std::abs(denominator)>1e-12?(nsdf[chosen+1]-nsdf[chosen-1])/denominator:0;
        out.hz=Rate/(static_cast<double>(chosen)+shift);out.midi=69+12*std::log2(out.hz/440);out.clarity=nsdf[chosen];
        const auto nearest=static_cast<int>(std::lround(out.midi));const char* names[]={"C","C#","D","D#","E","F","F#","G","G#","A","A#","B"};
        out.name=std::string(names[(nearest%12+12)%12])+std::to_string(nearest/12-1);out.available=true;return out;
    }
};
}
